import type { PlannedResourcePath } from '../domain/path-plan.js';
import type { Nodes, Root } from 'mdast';
import type { Parent } from 'unist';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { DomainError } from '../errors.js';
import {
  extractNotionIdFromPathSegment,
  normalizeNotionId,
} from '../notion-id.js';

export function extractNotionPageId(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'notion.so' && !hostname.endsWith('.notion.so')) {
    return undefined;
  }
  const segment = url.pathname.split('/').filter(Boolean).at(-1);
  if (!segment) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  return extractNotionIdFromPathSegment(decoded);
}

export function buildIdToPathMap(
  paths: readonly PlannedResourcePath[],
): Map<string, string> {
  return new Map(paths.map((path) => [path.notionId, path.expectedPath]));
}

function normalizedPaths(
  idToPath: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const normalized = new Map<string, string>();
  for (const [notionId, path] of idToPath) {
    const id = normalizeNotionId(notionId);
    if (!id) continue;
    const existing = normalized.get(id);
    if (existing && existing !== path) {
      throw new DomainError(
        'validation',
        `Conflicting paths for Notion page ID: ${notionId}`,
      );
    }
    normalized.set(id, path);
  }
  return normalized;
}

function wikiPath(expectedPath: string): string {
  return expectedPath.replaceAll('\\', '/').replace(/\.md$/iu, '');
}

function wikiAlias(value: string): string {
  return value
    .replaceAll('\n', ' ')
    .replaceAll('|', '\\|')
    .replaceAll(']', '\\]');
}

function wikiLink(expectedPath: string, label: string): Nodes {
  const path = wikiPath(expectedPath);
  const alias = wikiAlias(label.trim() || path.split('/').at(-1) || path);
  return { type: 'html', value: `[[${path}|${alias}]]` };
}

function nodeText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if ('children' in node && Array.isArray(node.children)) {
    return (node.children as Nodes[]).map(nodeText).join('');
  }
  return '';
}

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

function resolveUrl(
  url: string | undefined,
  paths: ReadonlyMap<string, string>,
): string | undefined {
  if (!url) return undefined;
  const notionId = extractNotionPageId(url);
  return notionId ? paths.get(notionId) : undefined;
}

type PageElementTag = 'mention-page' | 'page';

function pageElementTag(value: string): PageElementTag | undefined {
  const opening = value.trimStart().toLowerCase();
  for (const tag of ['mention-page', 'page'] as const) {
    const prefix = `<${tag}`;
    if (!opening.startsWith(prefix)) continue;
    const boundary = opening[prefix.length];
    if (boundary === '>' || boundary === '/' || /\s/u.test(boundary ?? '')) {
      return tag;
    }
  }
  return undefined;
}

function completePageElement(
  value: string,
  paths: ReadonlyMap<string, string>,
): Nodes | undefined {
  const trimmed = value.trim();
  const tag = pageElementTag(trimmed);
  if (!tag) return undefined;
  const openingEnd = trimmed.indexOf('>');
  const closingStart = trimmed.toLowerCase().lastIndexOf(`</${tag}>`);
  if (openingEnd === -1 || closingStart < openingEnd) return undefined;
  const openingTag = trimmed.slice(0, openingEnd + 1);
  const path = resolveUrl(attributeValue(openingTag, 'url'), paths);
  if (!path) return undefined;
  const body = trimmed.slice(openingEnd + 1, closingStart);
  const parsed = unified().use(remarkParse).parse(body);
  return wikiLink(path, nodeText(parsed));
}

function transformParent(
  parent: Parent,
  paths: ReadonlyMap<string, string>,
): void {
  const children = parent.children as Nodes[];
  const transformed: Nodes[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type === 'link') {
      const path = resolveUrl(child.url, paths);
      if (path) {
        transformed.push(wikiLink(path, nodeText(child)));
        continue;
      }
    }
    if (child.type === 'html') {
      const complete = completePageElement(child.value, paths);
      if (complete) {
        transformed.push(complete);
        continue;
      }
      const tag = pageElementTag(child.value);
      if (tag) {
        const closingIndex = children.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > index &&
            candidate.type === 'html' &&
            candidate.value.toLowerCase() === `</${tag}>`,
        );
        const path = resolveUrl(attributeValue(child.value, 'url'), paths);
        if (closingIndex > index && path) {
          const label = children
            .slice(index + 1, closingIndex)
            .map(nodeText)
            .join('');
          transformed.push(wikiLink(path, label));
          index = closingIndex;
          continue;
        }
      }
    }
    if ('children' in child && Array.isArray(child.children)) {
      transformParent(child, paths);
    }
    transformed.push(child);
  }
  parent.children = transformed;
}

function internalLinks(paths: ReadonlyMap<string, string>): Plugin<[], Root> {
  return () => (tree) => transformParent(tree, paths);
}

export async function resolveInternalLinks(
  markdown: string,
  idToPath: ReadonlyMap<string, string>,
): Promise<string> {
  const paths = normalizedPaths(idToPath);
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(internalLinks(paths))
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      listItemIndent: 'one',
      rule: '-',
    });
  return String(await processor.process(markdown));
}
