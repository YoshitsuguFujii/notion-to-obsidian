import { InfraError } from '../errors.js';
import {
  preserveUnsupportedBlock,
  unsupportedBlockPlaceholder,
  type UnsupportedSidecar,
} from '../transform/unsupported.js';
import type { NotionClient } from './types.js';
import { retrieveBlockTree } from './blocks.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import {
  renderFallbackBlocks,
  type FallbackWarning,
} from '../transform/fallback-block-renderer.js';

interface MarkdownResponse {
  markdown: string;
  truncated: boolean;
  unknownBlockIds: string[];
}

export interface MarkdownWarning {
  type:
    | 'ambiguous_unknown_positions'
    | 'block_unavailable'
    | 'block_retrieval_failed'
    | 'truncated';
  blockId?: string;
  message: string;
}

export interface RetrievedMarkdown {
  markdown: string;
  needsBlockFallback: boolean;
  warnings: MarkdownWarning[];
  sidecars: UnsupportedSidecar[];
}

function parseMarkdownResponse(value: unknown): MarkdownResponse {
  if (!value || typeof value !== 'object') {
    throw new InfraError('validation', 'Invalid Markdown API response');
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.markdown !== 'string' ||
    typeof response.truncated !== 'boolean' ||
    !Array.isArray(response.unknown_block_ids) ||
    !response.unknown_block_ids.every((id) => typeof id === 'string')
  ) {
    throw new InfraError('validation', 'Invalid Markdown API response');
  }
  return {
    markdown: response.markdown,
    truncated: response.truncated,
    unknownBlockIds: response.unknown_block_ids,
  };
}

interface TokenRange {
  start: number;
  end: number;
}

interface AstNode {
  type?: unknown;
  value?: unknown;
  children?: unknown;
  position?: {
    start?: { offset?: unknown };
    end?: { offset?: unknown };
  };
}

function unknownTokenRanges(markdown: string): TokenRange[] {
  const ranges: TokenRange[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as AstNode;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (
      node.type === 'html' &&
      node.value === '<unknown>' &&
      typeof start === 'number' &&
      typeof end === 'number'
    ) {
      ranges.push({ start, end });
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(unified().use(remarkParse).parse(markdown));
  return ranges.sort((left, right) => left.start - right.start);
}

function replaceUnknownTokens(
  markdown: string,
  replacements: readonly string[],
  ranges: readonly TokenRange[],
): string {
  let result = '';
  let offset = 0;
  replacements.forEach((replacement, index) => {
    const range = ranges[index];
    if (!range) return;
    result += markdown.slice(offset, range.start);
    result += replacement;
    offset = range.end;
  });
  return result + markdown.slice(offset);
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return undefined;
  const nested = (cause as { status?: unknown }).status;
  return typeof nested === 'number' ? nested : undefined;
}

export async function retrievePageMarkdown(
  client: Pick<NotionClient, 'retrieveMarkdown'>,
  pageId: string,
): Promise<RetrievedMarkdown> {
  const primary = parseMarkdownResponse(await client.retrieveMarkdown(pageId));
  const warnings: MarkdownWarning[] = [];
  const sidecars: UnsupportedSidecar[] = [];

  if (primary.unknownBlockIds.length === 0) {
    if (primary.truncated) {
      warnings.push({
        type: 'truncated',
        message: 'Markdown API response was truncated',
      });
    }
    return {
      markdown: primary.markdown,
      needsBlockFallback: primary.truncated,
      warnings,
      sidecars,
    };
  }

  const tokenRanges = unknownTokenRanges(primary.markdown);
  if (tokenRanges.length !== primary.unknownBlockIds.length) {
    warnings.push({
      type: 'ambiguous_unknown_positions',
      message: 'Unknown block positions cannot be matched uniquely',
    });
    return {
      markdown: primary.markdown,
      needsBlockFallback: true,
      warnings,
      sidecars,
    };
  }

  const replacements: string[] = [];
  let retrievalFailed = false;
  for (const blockId of primary.unknownBlockIds) {
    try {
      const supplemental = parseMarkdownResponse(
        await client.retrieveMarkdown(blockId),
      );
      if (supplemental.truncated || supplemental.unknownBlockIds.length > 0) {
        retrievalFailed = true;
        warnings.push({
          type: 'block_retrieval_failed',
          blockId,
          message: 'Unknown block retrieval was incomplete',
        });
        break;
      }
      replacements.push(supplemental.markdown);
    } catch (error) {
      if (statusOf(error) === 404) {
        const sidecar = preserveUnsupportedBlock('unavailable', blockId, {
          blockId,
          status: 'unavailable',
        });
        sidecars.push(sidecar);
        warnings.push({
          type: 'block_unavailable',
          blockId,
          message: 'Unknown block could not be retrieved',
        });
        replacements.push(unsupportedBlockPlaceholder('unavailable', blockId));
        continue;
      }
      retrievalFailed = true;
      warnings.push({
        type: 'block_retrieval_failed',
        blockId,
        message: 'Unknown block retrieval failed',
      });
      break;
    }
  }

  if (
    retrievalFailed ||
    replacements.length !== primary.unknownBlockIds.length
  ) {
    return {
      markdown: primary.markdown,
      needsBlockFallback: true,
      warnings,
      sidecars,
    };
  }
  if (primary.truncated) {
    warnings.push({
      type: 'truncated',
      message: 'Markdown API response was truncated',
    });
  }
  return {
    markdown: replaceUnknownTokens(primary.markdown, replacements, tokenRanges),
    needsBlockFallback: primary.truncated,
    warnings,
    sidecars,
  };
}

export interface RetrievedPageContent {
  markdown: string;
  source: 'markdown' | 'block';
  warnings: Array<MarkdownWarning | FallbackWarning>;
  sidecars: UnsupportedSidecar[];
}

export async function retrieveMarkdownWithFallback(
  client: NotionClient,
  pageId: string,
): Promise<RetrievedPageContent> {
  const primary = await retrievePageMarkdown(client, pageId);
  if (!primary.needsBlockFallback) {
    return {
      markdown: primary.markdown,
      source: 'markdown',
      warnings: primary.warnings,
      sidecars: primary.sidecars,
    };
  }
  const fallback = renderFallbackBlocks(
    await retrieveBlockTree(client, pageId),
  );
  return {
    markdown: fallback.markdown,
    source: 'block',
    warnings: [...primary.warnings, ...fallback.warnings],
    sidecars: [...primary.sidecars, ...fallback.sidecars],
  };
}
