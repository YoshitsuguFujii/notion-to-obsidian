import type { Root, RootContent } from 'mdast';
import type { Parent } from 'unist';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { buildMarkdownTableText } from './table-markdown.js';

function attributeValue(openingTag: string, name: string): string | undefined {
  let offset = 0;
  while (offset < openingTag.length) {
    const position = openingTag.indexOf(name, offset);
    if (position === -1) return undefined;
    const before = openingTag[position - 1];
    const after = openingTag[position + name.length];
    if (
      (before === undefined || /\s/u.test(before)) &&
      (after === '=' || /\s/u.test(after ?? ''))
    ) {
      let cursor = position + name.length;
      while (/\s/u.test(openingTag[cursor] ?? '')) cursor += 1;
      if (openingTag[cursor] !== '=') {
        offset = position + name.length;
        continue;
      }
      cursor += 1;
      while (/\s/u.test(openingTag[cursor] ?? '')) cursor += 1;
      const quote = openingTag[cursor];
      if (quote !== '"' && quote !== "'") return undefined;
      const end = openingTag.indexOf(quote, cursor + 1);
      return end === -1 ? undefined : openingTag.slice(cursor + 1, end);
    }
    offset = position + name.length;
  }
  return undefined;
}

function elementBody(value: string, tag: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(`<${tag}`)) return undefined;
  const openingEnd = trimmed.indexOf('>');
  const closingStart = trimmed.toLowerCase().lastIndexOf(`</${tag}>`);
  if (openingEnd === -1 || closingStart < openingEnd) return undefined;
  return trimmed.slice(openingEnd + 1, closingStart).trim();
}

function formatCallout(openingTag: string, body: string): string {
  const requestedType = attributeValue(openingTag, 'type') ?? 'note';
  const type = /^[a-z][a-z0-9-]*$/iu.test(requestedType)
    ? requestedType.toLowerCase()
    : 'note';
  const quotedBody = body
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> [!${type}]${quotedBody ? `\n${quotedBody}` : ''}`;
}

function calloutMarkdown(value: string): string | undefined {
  const body = elementBody(value, 'callout');
  if (body === undefined) return undefined;
  const openingEnd = value.indexOf('>');
  const openingTag = openingEnd === -1 ? '' : value.slice(0, openingEnd + 1);
  return formatCallout(openingTag, body);
}

function inlineCallout(child: RootContent): string | undefined {
  if (child.type !== 'paragraph' || child.children.length < 3) return undefined;
  const first = child.children[0];
  const last = child.children.at(-1);
  if (
    first?.type !== 'html' ||
    !first.value.toLowerCase().startsWith('<callout') ||
    last?.type !== 'html' ||
    last.value.toLowerCase() !== '</callout>'
  )
    return undefined;
  const paragraph = {
    type: 'paragraph' as const,
    children: child.children.slice(1, -1),
  };
  const body = unified()
    .use(remarkStringify)
    .stringify({ type: 'root', children: [paragraph] })
    .trim();
  return formatCallout(first.value, body);
}

function columnsMarkdown(value: string): string | undefined {
  const body = elementBody(value, 'columns');
  if (body === undefined) return undefined;
  const output: string[] = [];
  for (const line of body.split('\n')) {
    const tag = line.trim().toLowerCase();
    if (tag.startsWith('<column') && tag.endsWith('>')) continue;
    if (tag === '</column>') {
      if (output.at(-1) !== '') output.push('');
      continue;
    }
    output.push(line);
  }
  while (output.at(-1) === '') output.pop();
  return output.join('\n');
}

function tableMarkdown(value: string): string | undefined {
  const body = elementBody(value, 'table');
  if (body === undefined) return undefined;
  const openingEnd = value.indexOf('>');
  const openingTag = openingEnd === -1 ? '' : value.slice(0, openingEnd + 1);

  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/giu;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(body)) !== null) {
    const rowBody = rowMatch[1] ?? '';
    if (/<th[\s>]/iu.test(rowBody)) return undefined;
    const cells: string[] = [];
    const cellRegex = /<td([^>]*)>([\s\S]*?)<\/td>/giu;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowBody)) !== null) {
      const attrs = cellMatch[1] ?? '';
      const cellText = cellMatch[2] ?? '';
      if (/\b(?:colspan|rowspan)\s*=/iu.test(attrs)) return undefined;
      cells.push(cellText.trim().replace(/\s*\n\s*/gu, ' '));
    }
    rows.push(cells);
  }

  const columnCount = rows[0]?.length ?? 0;
  if (columnCount === 0 || rows.some((row) => row.length !== columnCount))
    return undefined;

  const hasHeaderRow = attributeValue(openingTag, 'header-row') === 'true';
  return buildMarkdownTableText(rows, hasHeaderRow);
}

function transformParent(parent: Parent): void {
  const transformed: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    const inline = inlineCallout(child);
    if (inline !== undefined) {
      transformed.push({ type: 'html', value: inline });
      continue;
    }
    if (child.type === 'html') {
      const callout = calloutMarkdown(child.value);
      if (callout !== undefined) {
        transformed.push({ type: 'html', value: callout });
        continue;
      }
      const columns = columnsMarkdown(child.value);
      if (columns !== undefined) {
        const fragment = unified()
          .use(remarkParse)
          .use(remarkGfm)
          .parse(columns);
        transformed.push(...fragment.children);
        continue;
      }
      const table = tableMarkdown(child.value);
      if (table !== undefined) {
        const fragment = unified().use(remarkParse).use(remarkGfm).parse(table);
        transformed.push(...fragment.children);
        continue;
      }
    }
    if ('children' in child && Array.isArray(child.children)) {
      transformParent(child);
    }
    transformed.push(child);
  }
  parent.children = transformed;
}

const notionEnhancedElements: Plugin<[], Root> = () => (tree) => {
  transformParent(tree);
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(notionEnhancedElements)
  .use(remarkStringify, {
    bullet: '-',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
  });

export async function transformEnhancedMarkdown(
  markdown: string,
): Promise<string> {
  return String(await processor.process(markdown));
}
