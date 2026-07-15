import { posix } from 'node:path';
import type { BlockNode } from '../notion/blocks.js';
import { sanitizePathSegment } from '../filesystem/safe-path.js';

export type AssetKind = 'image' | 'file';

export interface MarkdownAsset {
  kind: AssetKind;
  url: string;
  filename: string | undefined;
  caption: string;
  occurrence: number;
}

export interface BlockAsset extends Omit<MarkdownAsset, 'url'> {
  blockId: string;
  url: string | undefined;
}

export type AssetMatch =
  | {
      markdownIndex: number;
      status: 'matched';
      blockId: string;
      strategy: 'url_path' | 'filename' | 'position_caption';
    }
  | {
      markdownIndex: number;
      status: 'ambiguous';
      reason: string;
    }
  | {
      markdownIndex: number;
      status: 'unmatched';
      reason: string;
    };

type AssetMatchStrategy = 'url_path' | 'filename' | 'position_caption';

const assetBlockTypes = new Set(['image', 'file', 'pdf', 'video', 'audio']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const item = record(part);
      return typeof item?.plain_text === 'string' ? item.plain_text : '';
    })
    .join('');
}

function assetUrl(value: Record<string, unknown>): string | undefined {
  const sourceType = typeof value.type === 'string' ? value.type : undefined;
  const source = sourceType ? record(value[sourceType]) : undefined;
  return typeof source?.url === 'string' ? source.url : undefined;
}

function filenameFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const segment = new URL(value).pathname.split('/').filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

export function extractBlockAssets(nodes: readonly BlockNode[]): BlockAsset[] {
  const assets: BlockAsset[] = [];
  const occurrences: Record<AssetKind, number> = { image: 0, file: 0 };
  const visit = (node: BlockNode): void => {
    const type = typeof node.block.type === 'string' ? node.block.type : '';
    const blockId = typeof node.block.id === 'string' ? node.block.id : '';
    if (blockId && assetBlockTypes.has(type)) {
      const value = record(node.block[type]) ?? {};
      const url = assetUrl(value);
      if (url) {
        const kind: AssetKind = type === 'image' ? 'image' : 'file';
        const occurrence = occurrences[kind];
        occurrences[kind] += 1;
        assets.push({
          blockId,
          kind,
          url,
          filename:
            typeof value.name === 'string' ? value.name : filenameFromUrl(url),
          caption: richText(value.caption),
          occurrence,
        });
      }
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return assets;
}

function normalizedUrlPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(new URL(value).pathname).normalize('NFC');
  } catch {
    return undefined;
  }
}

function normalizedFilename(value: string | undefined): string | undefined {
  const filename = value?.normalize('NFC').toLocaleLowerCase('en-US');
  return filename && filename.length > 0 ? filename : undefined;
}

function uniqueCandidate(
  candidates: readonly BlockAsset[],
  markdownIndex: number,
  strategy: AssetMatchStrategy,
): AssetMatch | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    return {
      markdownIndex,
      status: 'ambiguous',
      reason: `${strategy} matched multiple blocks`,
    };
  }
  const candidate = candidates[0];
  return candidate
    ? {
        markdownIndex,
        status: 'matched',
        blockId: candidate.blockId,
        strategy,
      }
    : undefined;
}

export function matchMarkdownAssets(
  markdownAssets: readonly MarkdownAsset[],
  blockAssets: readonly BlockAsset[],
): AssetMatch[] {
  const consumed = new Set<string>();
  return markdownAssets.map((asset, markdownIndex) => {
    const available = blockAssets.filter(
      (candidate) => !consumed.has(candidate.blockId),
    );
    const path = normalizedUrlPath(asset.url);
    if (path) {
      const match = uniqueCandidate(
        available.filter(
          (candidate) => normalizedUrlPath(candidate.url) === path,
        ),
        markdownIndex,
        'url_path',
      );
      if (match) {
        if (match.status === 'matched') consumed.add(match.blockId);
        return match;
      }
    }
    const filename = normalizedFilename(asset.filename);
    if (filename) {
      const match = uniqueCandidate(
        available.filter(
          (candidate) => normalizedFilename(candidate.filename) === filename,
        ),
        markdownIndex,
        'filename',
      );
      if (match) {
        if (match.status === 'matched') consumed.add(match.blockId);
        return match;
      }
    }
    const positional = uniqueCandidate(
      available.filter(
        (candidate) =>
          candidate.kind === asset.kind &&
          candidate.occurrence === asset.occurrence &&
          candidate.caption === asset.caption,
      ),
      markdownIndex,
      'position_caption',
    );
    if (positional) {
      if (positional.status === 'matched') consumed.add(positional.blockId);
      return positional;
    }
    return {
      markdownIndex,
      status: 'unmatched',
      reason: 'No block matched this Markdown asset',
    };
  });
}

export function createStableAssetKey(pageId: string, blockId: string): string {
  return `${pageId}:${blockId}`;
}

const mimeExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
  ['application/pdf', '.pdf'],
]);

export function buildAssetPath(
  pageId: string,
  blockId: string,
  originalName: string,
  mimeType?: string,
): string {
  const originalExtension = posix.extname(originalName);
  const extension = /^\.[a-z0-9]{1,10}$/iu.test(originalExtension)
    ? originalExtension.toLowerCase()
    : ((mimeType ? mimeExtensions.get(mimeType.toLowerCase()) : undefined) ??
      '');
  const stem = originalExtension
    ? originalName.slice(0, -originalExtension.length)
    : originalName;
  const safePageId = sanitizePathSegment(pageId, pageId);
  const safeBlockId = sanitizePathSegment(blockId, blockId);
  const safeStem = sanitizePathSegment(stem || 'asset', blockId);
  return posix.join(
    '_assets',
    safePageId,
    `${safeBlockId}--${safeStem}${extension}`,
  );
}
