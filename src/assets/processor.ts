import { createHash } from 'node:crypto';
import { access, lstat } from 'node:fs/promises';
import { posix } from 'node:path';
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
    throw error;
  }
}

export async function processPageAssets(
  input: ProcessAssetsInput,
  dependencies: ProcessAssetsDependencies,
): Promise<{
  markdown: string;
  assets: AssetState[];
  warnings: WarningState[];
}> {
  const markdown = markdownAssets(input.markdown);
  const blocks = extractBlockAssets(input.blocks);
  const matches = matchMarkdownAssets(markdown, blocks);
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));
  const replacements = new Map<string, string>();
  const assets: AssetState[] = [];
  const warnings: WarningState[] = [];

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
    const relativePath = posix.relative(
      posix.dirname(input.pagePath),
      localPath,
    );
    const cached = previous && (await fileExists(absolutePath)) && !input.force;
    if (cached && previous) {
      replacements.set(candidate.url, relativePath);
      assets.push({ ...previous, lastSeenRunId: input.runId });
      continue;
    }
    if (!input.apply) continue;
    try {
      await assertNoSymlinkEscape(
        {
          async isSymbolicLink(candidate) {
            try {
              return (await lstat(candidate)).isSymbolicLink();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return false;
              throw error;
            }
          },
        },
        input.managedRoot,
        absolutePath,
      );
      const result = await dependencies.download({
        url: new URL(candidate.url),
        destination: absolutePath,
        maximumBytes: input.maximumBytes,
        allowedContentTypes:
          source === 'notion'
            ? input.notionAssetAllowedContentTypes
            : input.externalAssetAllowedContentTypes,
        allowedExtensions:
          source === 'notion'
            ? input.notionAssetAllowedExtensions
            : input.externalAssetAllowedExtensions,
      });
      const asset: AssetState = {
        stableKey,
        pageId: input.pageId,
        blockId,
        localPath,
        originalName,
        ...(result.contentType ? { mimeType: result.contentType } : {}),
        size: result.size,
        ...(result.etag ? { etag: result.etag } : {}),
        ...(result.lastModified ? { lastModified: result.lastModified } : {}),
        lastSeenRunId: input.runId,
        fetchedAt: input.now,
      };
      replacements.set(candidate.url, relativePath);
      assets.push(asset);
    } catch (error) {
      warnings.push({
        runId: input.runId,
        resourceId: input.pageId,
        warningType: 'asset_download_failed',
        message: `Asset download failed; remote URL was kept: ${error instanceof Error ? error.message : 'unknown error'}`,
        createdAt: input.now,
      });
    }
  }
  return {
    markdown: await rewriteAssetUrls(input.markdown, replacements),
    assets,
    warnings,
  };
}
