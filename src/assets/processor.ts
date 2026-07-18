import { createHash, randomUUID } from 'node:crypto';
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
import { InfraError } from '../errors.js';

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
  markdown: string;
  assets: AssetState[];
  warnings: WarningState[];
  downloads: PlannedAssetDownload[];
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
    const targetExists = previous && (await fileExists(absolutePath));
    const cached = targetExists && !input.force;
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
      cached: Boolean(cached),
    });
    if (previous && !input.force) {
      if (targetExists)
        await assertAssetPathSafe(input.managedRoot, absolutePath);
      replacements.set(candidate.url, relativePath);
      assets.push({ ...previous, lastSeenRunId: input.runId });
      continue;
    }
  }
  return {
    markdown: await rewriteAssetUrls(input.markdown, replacements),
    assets,
    warnings,
    downloads,
  };
}

export async function applyPlannedPageAssets(
  input: Pick<
    ProcessAssetsInput,
    'markdown' | 'managedRoot' | 'runId' | 'now' | 'maximumBytes'
  >,
  plan: PlannedPageAssets,
  dependencies: Pick<ProcessAssetsDependencies, 'download'>,
): Promise<Omit<PlannedPageAssets, 'downloads'>> {
  const replacements = new Map<string, string>();
  const downloadedKeys = new Set(
    plan.downloads.map(({ target }) => target.stableKey),
  );
  const assets = plan.assets.filter(
    ({ stableKey }) => !downloadedKeys.has(stableKey),
  );
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
      warnings.push({
        runId: input.runId,
        resourceId: target.pageId,
        warningType: 'asset_download_failed',
        message: `Asset download failed; remote URL was kept: ${error instanceof Error ? error.message : 'unknown error'}`,
        createdAt: input.now,
      });
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
    replacements.set(download.remoteUrl, download.relativePath);
    assets.push(asset);
  }
  return {
    markdown: await rewriteAssetUrls(plan.markdown, replacements),
    assets,
    warnings,
  };
}

export async function processPageAssets(
  input: ProcessAssetsInput,
  dependencies: ProcessAssetsDependencies,
): Promise<Omit<PlannedPageAssets, 'downloads'>> {
  const plan = await planPageAssets(input, dependencies);
  if (!input.apply) return plan;
  return applyPlannedPageAssets(
    input,
    { ...plan, downloads: plan.downloads.filter(({ cached }) => !cached) },
    dependencies,
  );
}
