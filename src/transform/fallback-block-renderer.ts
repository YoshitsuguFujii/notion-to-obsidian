import type { BlockNode } from '../notion/blocks.js';
import {
  preserveUnsupportedBlock,
  unsupportedBlockPlaceholder,
  type UnsupportedSidecar,
} from './unsupported.js';

export interface FallbackWarning {
  type: 'unsupported_block';
  blockId: string;
  blockType: string;
  message: string;
}

export interface FallbackRenderResult {
  markdown: string;
  warnings: FallbackWarning[];
  sidecars: UnsupportedSidecar[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? (value as UnknownRecord)
    : undefined;
}

function renderRichText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const richText = record(part);
      let text =
        (typeof richText?.plain_text === 'string' && richText.plain_text) ||
        (typeof record(richText?.text)?.content === 'string'
          ? (record(richText?.text)?.content as string)
          : '');
      const annotations = record(richText?.annotations);
      if (annotations?.code === true) text = `\`${text}\``;
      if (annotations?.bold === true) text = `**${text}**`;
      if (annotations?.italic === true) text = `*${text}*`;
      if (annotations?.strikethrough === true) text = `~~${text}~~`;
      const href =
        typeof richText?.href === 'string'
          ? richText.href
          : typeof record(richText?.text)?.link === 'object' &&
              typeof record(record(richText?.text)?.link)?.url === 'string'
            ? (record(record(richText?.text)?.link)?.url as string)
            : undefined;
      return href ? `[${text}](${href})` : text;
    })
    .join('');
}

function blockValue(block: UnknownRecord, type: string): UnknownRecord {
  return record(block[type]) ?? {};
}

function fileUrl(value: UnknownRecord): string | undefined {
  const sourceType = typeof value.type === 'string' ? value.type : undefined;
  const source = sourceType ? record(value[sourceType]) : undefined;
  return typeof source?.url === 'string' ? source.url : undefined;
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function renderFallbackBlocks(
  nodes: readonly BlockNode[],
): FallbackRenderResult {
  const warnings: FallbackWarning[] = [];
  const sidecars: UnsupportedSidecar[] = [];

  const renderNode = (node: BlockNode): string => {
    const block = node.block;
    const id = typeof block.id === 'string' ? block.id : 'unknown';
    const type = typeof block.type === 'string' ? block.type : 'unknown';
    const value = blockValue(block, type);
    const text = renderRichText(value.rich_text);
    const children = node.children.map(renderNode).filter(Boolean);
    const nested =
      children.length > 0 ? `\n${indent(children.join('\n'), 2)}` : '';

    switch (type) {
      case 'paragraph':
        return `${text}${children.length > 0 ? `\n${children.join('\n')}` : ''}`;
      case 'heading_1':
        return `# ${text}`;
      case 'heading_2':
        return `## ${text}`;
      case 'heading_3':
        return `### ${text}`;
      case 'bulleted_list_item':
        return `- ${text}${nested}`;
      case 'numbered_list_item':
        return `1. ${text}${nested}`;
      case 'to_do':
        return `- [${value.checked === true ? 'x' : ' '}] ${text}${nested}`;
      case 'quote':
        return text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
      case 'divider':
        return '---';
      case 'code': {
        const language =
          typeof value.language === 'string' ? value.language : '';
        return `\`\`\`${language}\n${text}\n\`\`\``;
      }
      case 'image': {
        const url = fileUrl(value);
        const caption = renderRichText(value.caption);
        return url ? `![${caption}](${url})` : unsupported(type, id, block);
      }
      case 'file': {
        const url = fileUrl(value);
        const name =
          typeof value.name === 'string' && value.name.length > 0
            ? value.name
            : renderRichText(value.caption) || 'File';
        return url ? `[${name}](${url})` : unsupported(type, id, block);
      }
      case 'equation':
        return typeof record(value.expression)?.value === 'string'
          ? `$$\n${record(value.expression)?.value as string}\n$$`
          : typeof value.expression === 'string'
            ? `$$\n${value.expression}\n$$`
            : unsupported(type, id, block);
      default:
        return unsupported(type, id, block);
    }
  };

  const unsupported = (type: string, id: string, payload: unknown): string => {
    warnings.push({
      type: 'unsupported_block',
      blockId: id,
      blockType: type,
      message: `Unsupported block preserved: ${type}`,
    });
    sidecars.push(preserveUnsupportedBlock(type, id, payload));
    return unsupportedBlockPlaceholder(type, id);
  };

  return {
    markdown: nodes.map(renderNode).filter(Boolean).join('\n\n'),
    warnings,
    sidecars,
  };
}
