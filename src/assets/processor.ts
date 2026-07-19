import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { BlockNode } from '../notion/blocks.js';
import type { AssetState, WarningState } from '../storage/state-store.js';
import { rewriteAssetUrls } from '../transform/asset-urls.js';
import {
  assertNoSymlinkEscape,
  joinManagedPath,
} from '../filesystem/safe-path.js';
import type { DownloadResult } from './http-downloader.js';
import {
  buildAssetPath,
  createStableAssetKey,
  extractBlockAssets,
  matchMarkdownAssets,
  type MarkdownAsset,
} from './mapping.js';
import { shouldDownloadAsset } from './policy.js';
import {
  assertAssetTargetIdentity,
  commitAssetDownload,
  type PlannedAssetTarget,
} from './target.js';
import { DomainError, InfraError } from '../errors.js';

interface ProcessAssetsInput {
  pageId: string;
  markdown: string;
  pagePath: string;
  blocks: readonly BlockNode[];
  managedRoot: string;
  runId: string;
  now: string;
  maximumBytes: number;
  notionAssetAllowedContentTypes: readonly string[];
  notionAssetAllowedExtensions: readonly string[];
  externalAssetAllowedContentTypes: readonly string[];
  externalAssetAllowedExtensions: readonly string[];
  downloadExternalAssets: boolean;
  apply: boolean;
  force?: boolean;
}

interface ProcessAssetsDependencies {
  getAsset(stableKey: string): AssetState | undefined;
  download(request: {
    url: URL;
    destination: string;
    maximumBytes: number;
    allowedContentTypes: readonly string[];
    allowedExtensions: readonly string[];
  }): Promise<DownloadResult>;
  fallbackFileSystem?: {
    lstat?(path: string): Promise<{
      isSymbolicLink(): boolean;
      isFile(): boolean;
      size: number;
    }>;
    createReadStream?(path: string): AsyncIterable<Buffer>;
  };
}

export interface PlannedAssetDownload {
  target: PlannedAssetTarget;
  remoteUrl: string;
  relativePath: string;
  allowedContentTypes: readonly string[];
  allowedExtensions: readonly string[];
  cached: boolean;
}

export interface PlannedPageAssets {
  sourceMarkdown: string;
  markdown: string;
  assets: AssetState[];
  warnings: WarningState[];
  downloads: PlannedAssetDownload[];
  cachedAdoptions: Array<{
    stableKey: string;
    remoteUrl: string;
    relativePath: string;
  }>;
}

export interface AppliedPageAssets {
  markdown: string;
  assets: AssetState[];
  warnings: WarningState[];
}

function nodeText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return (node.children as Nodes[]).map(nodeText).join('');
  }
  return '';
}

function filename(url: string): string | undefined {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

function markdownAssets(markdown: string): MarkdownAsset[] {
  const assets: MarkdownAsset[] = [];
  const occurrences = { image: 0, file: 0 };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as Nodes;
    if (node.type === 'image') {
      assets.push({
        kind: 'image',
        url: node.url,
        filename: filename(node.url),
        caption: node.alt ?? '',
        occurrence: occurrences.image++,
      });
    } else if (node.type === 'link') {
      assets.push({
        kind: 'file',
        url: node.url,
        filename: filename(node.url),
        caption: nodeText(node),
        occurrence: occurrences.file++,
      });
    }
    if ('children' in node && Array.isArray(node.children)) {
      node.children.forEach(visit);
    }
  };
  visit(unified().use(remarkParse).parse(markdown));
  return assets;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sanitizeDownloadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, (matched) => {
      const trailing = matched.match(/[),.;!?]+$/u)?.[0] ?? '';
      const value = trailing ? matched.slice(0, -trailing.length) : matched;
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}${url.search ? '?[REDACTED]' : ''}${trailing}`;
      } catch {
        return matched;
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|(?:notion[_-]?)?token|api[_-]?key|signature|x-amz-signature)\b\s*[:=]\s*[^\s,;]+/giu,
      '$1=[REDACTED]',
    )
    .replace(/\b[A-Z]:\\[^\s,;]+/giu, '[REDACTED_PATH]')
    .replace(/(^|[\s('"`])\/(?!\/)[^\s,;)]+/gu, '$1[REDACTED_PATH]');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new InfraError('storage', 'Asset target existence check failed', {
      cause: error,
    });
  }
}

export async function assertAssetPathSafe(
  managedRoot: string,
  absolutePath: string,
): Promise<void> {
  await assertNoSymlinkEscape(
    {
      async isSymbolicLink(candidate) {
        try {
          return (await lstat(candidate)).isSymbolicLink();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw new InfraError('storage', 'Asset path inspection failed', {
            cause: error,
          });
        }
      },
    },
    managedRoot,
    absolutePath,
  );
}

export async function planPageAssets(
  input: Omit<ProcessAssetsInput, 'apply'>,
  dependencies: Pick<ProcessAssetsDependencies, 'getAsset'>,
): Promise<PlannedPageAssets> {
  const markdown = markdownAssets(input.markdown);
  const blocks = extractBlockAssets(input.blocks);
  const matches = matchMarkdownAssets(markdown, blocks);
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));
  const replacements = new Map<string, string>();
  const assets: AssetState[] = [];
  const warnings: WarningState[] = [];
  const downloads: PlannedAssetDownload[] = [];
  const cachedAdoptions: PlannedPageAssets['cachedAdoptions'] = [];

  for (const [index, candidate] of markdown.entries()) {
    const match = matches[index];
    const matchedBlock =
      match?.status === 'matched' ? blockById.get(match.blockId) : undefined;
    const source = matchedBlock ? 'notion' : 'external';
    if (
      !shouldDownloadAsset(source, {
        downloadExternalAssets: input.downloadExternalAssets,
      }) ||
      (!matchedBlock && candidate.kind !== 'image')
    )
      continue;
    if (match?.status === 'ambiguous') {
      warnings.push({
        runId: input.runId,
        resourceId: input.pageId,
        warningType: 'asset_mapping_ambiguous',
        message: match.reason,
        createdAt: input.now,
      });
      continue;
    }
    const blockId =
      matchedBlock?.blockId ?? `external-${shortHash(candidate.url)}`;
    const originalName =
      matchedBlock?.filename ?? candidate.filename ?? `${candidate.kind}-asset`;
    const stableKey = createStableAssetKey(input.pageId, blockId);
    const previous = dependencies.getAsset(stableKey);
    const localPath =
      previous?.localPath ??
      buildAssetPath(input.pageId, blockId, originalName);
    const absolutePath = joinManagedPath(input.managedRoot, localPath);
    const target: PlannedAssetTarget = {
      stableKey,
      pageId: input.pageId,
      blockId,
      localPath,
      absolutePath,
      originalName: previous?.originalName ?? originalName,
      previous,
    };
    assertAssetTargetIdentity(target);
    const relativePath = posix.relative(
      posix.dirname(input.pagePath),
      localPath,
    );
    const targetExists = previous ? await fileExists(absolutePath) : false;
    const cached = previous !== undefined && !input.force && targetExists;
    downloads.push({
      target,
      remoteUrl: candidate.url,
      relativePath,
      allowedContentTypes:
        source === 'notion'
          ? input.notionAssetAllowedContentTypes
          : input.externalAssetAllowedContentTypes,
      allowedExtensions:
        source === 'notion'
          ? input.notionAssetAllowedExtensions
          : input.externalAssetAllowedExtensions,
      cached,
    });
    if (cached) {
      await assertAssetPathSafe(input.managedRoot, absolutePath);
      replacements.set(candidate.url, relativePath);
      assets.push({ ...previous, lastSeenRunId: input.runId });
      cachedAdoptions.push({
        stableKey,
        remoteUrl: candidate.url,
        relativePath,
      });
    }
  }
  return {
    sourceMarkdown: input.markdown,
    markdown: await rewriteAssetUrls(input.markdown, replacements),
    assets,
    warnings,
    downloads,
    cachedAdoptions,
  };
}

type AssetOutcome =
  | { kind: 'downloaded'; asset: AssetState }
  | { kind: 'verified'; asset: AssetState }
  | { kind: 'remote' };

function preferAssetOutcome(
  current: AssetOutcome | undefined,
  candidate: AssetOutcome,
): AssetOutcome {
  const priority = { remote: 0, verified: 1, downloaded: 2 } as const;
  if (!current || priority[candidate.kind] > priority[current.kind]) {
    return candidate;
  }
  return current;
}

async function verifyPreviousAsset(
  input: Pick<ProcessAssetsInput, 'managedRoot' | 'runId'>,
  target: PlannedAssetTarget,
  dependencies: Pick<ProcessAssetsDependencies, 'fallbackFileSystem'>,
): Promise<AssetState | undefined> {
  assertAssetTargetIdentity(target);
  await assertAssetPathSafe(input.managedRoot, target.absolutePath);
  const previous = target.previous;
  const fallbackFileSystem = dependencies.fallbackFileSystem;
  let current;
  try {
    current = await (fallbackFileSystem?.lstat ?? lstat)(target.absolutePath);
  } catch {
    return undefined;
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new DomainError(
      'safety',
      'Asset fallback target is not a regular file',
    );
  }
  if (previous?.contentHash === undefined || previous.size === undefined) {
    return undefined;
  }
  if (current.size !== previous.size) return undefined;
  const hash = createHash('sha256');
  try {
    const content = fallbackFileSystem?.createReadStream
      ? fallbackFileSystem.createReadStream(target.absolutePath)
      : (createReadStream(target.absolutePath) as AsyncIterable<Buffer>);
    for await (const chunk of content) {
      hash.update(chunk);
    }
  } catch {
    return undefined;
  }
  if (hash.digest('hex') !== previous.contentHash) return undefined;
  return { ...previous, lastSeenRunId: input.runId };
}

export async function applyPlannedPageAssets(
  input: Pick<
    ProcessAssetsInput,
    'managedRoot' | 'runId' | 'now' | 'maximumBytes'
  >,
  plan: PlannedPageAssets,
  dependencies: Pick<
    ProcessAssetsDependencies,
    'download' | 'fallbackFileSystem'
  >,
): Promise<AppliedPageAssets> {
  const selectedStableKeys = new Set(
    plan.downloads.map(({ target }) => target.stableKey),
  );
  const previousAssets = new Map(
    plan.assets.map((asset) => [asset.stableKey, asset]),
  );
  const outcomes = new Map<string, AssetOutcome>();
  const failureReasons = new Map<string, string[]>();
  for (const adoption of plan.cachedAdoptions) {
    if (selectedStableKeys.has(adoption.stableKey)) continue;
    const asset = previousAssets.get(adoption.stableKey);
    if (asset) outcomes.set(adoption.stableKey, { kind: 'verified', asset });
  }
  const warnings = [...plan.warnings];
  for (const download of plan.downloads) {
    const { target } = download;
    assertAssetTargetIdentity(target);
    await assertAssetPathSafe(input.managedRoot, target.absolutePath);
    const absolutePath = target.absolutePath;
    const extension = extname(absolutePath);
    const temporaryPath = join(
      dirname(absolutePath),
      `.${basename(absolutePath, extension)}.${randomUUID()}.asset-stage${extension}`,
    );
    let result: DownloadResult;
    try {
      result = await dependencies.download({
        url: new URL(download.remoteUrl),
        destination: temporaryPath,
        maximumBytes: input.maximumBytes,
        allowedContentTypes: download.allowedContentTypes,
        allowedExtensions: download.allowedExtensions,
      });
    } catch (error) {
      if (error instanceof InfraError && error.category === 'storage') {
        throw error;
      }
      const reasons = failureReasons.get(target.stableKey) ?? [];
      reasons.push(sanitizeDownloadFailure(error));
      failureReasons.set(target.stableKey, reasons);
      const verified = await verifyPreviousAsset(input, target, dependencies);
      outcomes.set(
        target.stableKey,
        preferAssetOutcome(
          outcomes.get(target.stableKey),
          verified ? { kind: 'verified', asset: verified } : { kind: 'remote' },
        ),
      );
      continue;
    }
    try {
      await assertAssetPathSafe(input.managedRoot, absolutePath);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Cleanup is best effort so the path safety failure remains primary.
      }
      throw error;
    }
    await commitAssetDownload({
      target,
      temporaryPath,
      desiredHash: result.contentHash,
      desiredSize: result.size,
    });
    const asset: AssetState = {
      stableKey: target.stableKey,
      pageId: target.pageId,
      blockId: target.blockId,
      localPath: target.localPath,
      originalName: target.originalName,
      contentHash: result.contentHash,
      ...(result.contentType ? { mimeType: result.contentType } : {}),
      size: result.size,
      ...(result.etag ? { etag: result.etag } : {}),
      ...(result.lastModified ? { lastModified: result.lastModified } : {}),
      lastSeenRunId: input.runId,
      fetchedAt: input.now,
    };
    outcomes.set(
      target.stableKey,
      preferAssetOutcome(outcomes.get(target.stableKey), {
        kind: 'downloaded',
        asset,
      }),
    );
  }
  const replacements = new Map<string, string>();
  const mappings = [
    ...plan.cachedAdoptions,
    ...plan.downloads.map(({ target, remoteUrl, relativePath }) => ({
      stableKey: target.stableKey,
      remoteUrl,
      relativePath,
    })),
  ];
  for (const mapping of mappings) {
    const outcome = outcomes.get(mapping.stableKey);
    if (outcome && outcome.kind !== 'remote') {
      replacements.set(mapping.remoteUrl, mapping.relativePath);
    }
  }
  for (const [stableKey, outcome] of outcomes) {
    if (!selectedStableKeys.has(stableKey) || outcome.kind === 'downloaded') {
      continue;
    }
    const target = plan.downloads.find(
      (download) => download.target.stableKey === stableKey,
    )?.target;
    if (!target) continue;
    const reason = [...new Set(failureReasons.get(stableKey) ?? [])].sort()[0];
    if (!reason) continue;
    const message =
      outcome.kind === 'verified'
        ? 'Asset download failed; the existing cached file was verified and kept. The asset will be retried on a later sync.'
        : target.previous
          ? 'Asset download failed; the cached file could not be verified, so the remote URL was kept. Check the asset warning and retry the sync.'
          : 'Asset download failed; the remote URL was kept. Check the asset warning and retry the sync.';
    warnings.push({
      runId: input.runId,
      resourceId: target.pageId,
      warningType: 'asset_download_failed',
      message: `${message} Reason: ${reason}`,
      createdAt: input.now,
    });
  }
  return {
    markdown: await rewriteAssetUrls(plan.sourceMarkdown, replacements),
    assets: [...outcomes.values()]
      .filter(
        (outcome): outcome is Exclude<AssetOutcome, { kind: 'remote' }> =>
          outcome.kind !== 'remote',
      )
      .map(({ asset }) => asset),
    warnings,
  };
}

export async function processPageAssets(
  input: ProcessAssetsInput,
  dependencies: ProcessAssetsDependencies,
): Promise<AppliedPageAssets> {
  const plan = await planPageAssets(input, dependencies);
  if (!input.apply) {
    return {
      markdown: plan.markdown,
      assets: plan.assets,
      warnings: plan.warnings,
    };
  }
  return applyPlannedPageAssets(
    input,
    { ...plan, downloads: plan.downloads.filter(({ cached }) => !cached) },
    dependencies,
  );
}
