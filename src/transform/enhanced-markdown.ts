import type { PhrasingContent, Root, RootContent } from 'mdast';
import type { Parent } from 'unist';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { buildMarkdownTableText } from './table-markdown.js';

interface Range {
  start: number;
  end: number;
}

interface PositionedNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: PositionedNode[];
}

const parseOnlyProcessor = unified().use(remarkParse).use(remarkGfm);

// code / inlineCode ノードの位置範囲。この範囲内の文字列はpre-parseの
// アンダースコア入りタグ名リネームで一切書き換えない（AGENTS.mdの安全
// 不変条件：code/inline code内を正規表現で壊さない）。stringifyは行わず
// 位置情報だけを取る（signed-asset-urls.tsのdestinationTokenSpans方式を踏襲）。
function collectUneditableRanges(markdown: string): Range[] {
  const ranges: Range[] = [];
  const collect = (node: PositionedNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === 'code' || node.type === 'inlineCode') &&
      start !== undefined &&
      end !== undefined
    )
      ranges.push({ start, end });
    for (const child of node.children ?? []) collect(child);
  };
  collect(parseOnlyProcessor.parse(markdown) as PositionedNode);
  return ranges;
}

function isWithinRange(index: number, ranges: readonly Range[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

// remarkのHTMLタグ名判定はアンダースコアを許可しないため、Notionが直接
// 出力するアンダースコア入りタグ名（synced_block, table_of_contents）は
// HTMLノードとして認識されず、地の文としてエスケープされ破損する。
// 既知タグ名のみをホワイトリストでリネームし、remarkがHTMLとして正しく
// 認識できる形にする。code/inlineCode内の同名文字列は書き換えない。
const knownUnderscoreTagNames = ['synced_block', 'table_of_contents'] as const;

function renameKnownUnderscoreTags(markdown: string): string {
  if (!knownUnderscoreTagNames.some((name) => markdown.includes(name)))
    return markdown;
  let uneditableRanges: Range[];
  try {
    uneditableRanges = collectUneditableRanges(markdown);
  } catch {
    // 除外範囲を確定できない場合、code内を誤って書き換えるより
    // 安全側に倒してリネーム自体を行わない。
    return markdown;
  }
  const pattern = new RegExp(
    `</?(${knownUnderscoreTagNames.join('|')})\\b`,
    'g',
  );
  let result = '';
  let cursor = 0;
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index;
    if (isWithinRange(index, uneditableRanges)) continue;
    const tagName = match[1]!;
    const renamed = match[0].replace(tagName, tagName.replaceAll('_', '-'));
    result += markdown.slice(cursor, index) + renamed;
    cursor = index + match[0].length;
  }
  return result + markdown.slice(cursor);
}

// リネーム後のタグ名が、削除・変換のいずれにも該当せずhtmlノードとして
// そのまま出力に残る場合（例: 直後に空行なしで本文が続くtable_of_contents、
// 変換が未実装のタグ）に、内部処理用のリネーム痕跡を元の綴りへ戻す。
// html型ノードはremark-stringifyがそのまま出力するため、ここで戻しても
// 再度エスケープされて壊れることはない（実測で確認済み）。
function restoreKnownUnderscoreTags(value: string): string {
  const pattern = new RegExp(
    `</?(${knownUnderscoreTagNames.map((name) => name.replaceAll('_', '-')).join('|')})\\b`,
    'g',
  );
  return value.replace(pattern, (match) => match.replaceAll('-', '_'));
}

interface HtmlLikeNode {
  type: string;
  value?: string;
  children?: HtmlLikeNode[];
}

const restorableFragmentNodeTypes = new Set(['html', 'code', 'inlineCode']);
const restorableHtmlOnlyNodeTypes = new Set(['html']);

// callout/columns/tableの変換結果（生成した文字列そのもの、または再parse
// したfragment）にリネーム痕跡が紛れ込む場合がある。table/columnsは
// CommonMark上は不透明なHTMLブロックのため、元文書の1回目のparse時点では
// セル内のバッククォート区間がcode/inlineCodeノードとして認識されず、
// collectUneditableRangesの除外対象にならない。そのためfragment内では
// html/code/inlineCodeのいずれも復元対象にする（fragmentは元々table/columns
// のHTMLブロック内にあった文字列だけが由来のため、元文書の正規のcode/
// inlineCodeノードを壊す心配はない）。
//
// 一方、1行に収まるsynced_block（inlineSyncedBlockChildren）の中身は元文書の
// 1回目のparseで既にcode/inlineCodeノードとして認識済み＝リネーム対象外
// だったノードそのものであり、fragment由来ではない。ここでcode/inlineCode
// まで復元対象にすると、著者が本文にハイフン形（例: `<synced-block>`）を
// インラインコードとして書いていた場合に誤って書き換えてしまう。そのため
// inline経路ではhtml型のみを復元対象にする。
function restoreUnderscoreTagsDeep(
  node: HtmlLikeNode,
  restorableTypes: ReadonlySet<string> = restorableFragmentNodeTypes,
): void {
  if (restorableTypes.has(node.type) && typeof node.value === 'string') {
    node.value = restoreKnownUnderscoreTags(node.value);
  }
  for (const child of node.children ?? [])
    restoreUnderscoreTagsDeep(child, restorableTypes);
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

// 1行に収まるsynced_block（例: `<synced_block ...>Body</synced_block>`）は、
// 段落内の開始・終了タグに挟まれたinlineノードとしてASTに載る（callout同様）。
// 中身のノードをそのまま段落の子として展開する。
function inlineSyncedBlockChildren(
  child: RootContent,
): PhrasingContent[] | undefined {
  if (child.type !== 'paragraph' || child.children.length < 2) return undefined;
  const first = child.children[0];
  const last = child.children.at(-1);
  if (
    first?.type !== 'html' ||
    !first.value.toLowerCase().startsWith('<synced-block') ||
    last?.type !== 'html' ||
    last.value.toLowerCase() !== '</synced-block>'
  )
    return undefined;
  return child.children.slice(1, -1);
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

// Notionの同期ブロック（synced_block、リネーム後synced-block）は、複数箇所に
// 同一内容を複製表示するUI機能であり、片方向ミラーであるObsidian側では
// 複製元・複製先の区別に意味が無い。タグを外し中身をそのまま段落として残す。
// url属性は開始タグ側にありbody抽出の対象外なので、リンクとして誤認識される
// ことはない。
function syncedBlockMarkdown(value: string): string | undefined {
  const trimmed = value.trim();
  const closingTag = '</synced-block>';
  const closingStart = trimmed.toLowerCase().lastIndexOf(closingTag);
  // 閉じタグが無ければ展開できない（elementBodyがundefinedを返す経路と同じ）。
  if (closingStart === -1) return undefined;
  // HTMLブロックは空行まで後続行を吸収するため、閉じタグ直後（空行なし）に
  // 本文が続く場合は同じノードにその本文が混入している。安全側に倒し、
  // タグ単体で完結する場合（閉じタグ以降が空白のみ）に限って展開する。
  if (trimmed.slice(closingStart + closingTag.length).trim() !== '')
    return undefined;
  return elementBody(value, 'synced-block');
}

// `<table>` の中身は、tableMarkdown が丸ごと置換する対象になる。<tr>/<td> だけを
// 正規表現で拾う実装だと、caption・セル間の孤立テキスト・</table> 後方の後続内容・
// <trfoo> のような類似タグを黙って捨ててしまう（安全不変条件8違反）。そのため、
// 空白・colgroup（任意）・tr だけで body 全体が過不足なく消費されることを検証し、
// 1文字でも未認識の残りがあれば undefined を返して元の HTML を維持する。
function startsWithTagBoundary(
  source: string,
  pos: number,
  tag: string,
): boolean {
  const prefix = `<${tag}`;
  if (source.slice(pos, pos + prefix.length).toLowerCase() !== prefix)
    return false;
  const after = source[pos + prefix.length];
  return after === '>' || (after !== undefined && /\s/u.test(after));
}

function parseStrictRow(rowBody: string): string[] | undefined {
  const cells: string[] = [];
  let pos = 0;
  while (pos < rowBody.length) {
    while (pos < rowBody.length && /\s/u.test(rowBody[pos] ?? '')) pos += 1;
    if (pos >= rowBody.length) break;
    if (!startsWithTagBoundary(rowBody, pos, 'td')) return undefined;
    const openingEnd = rowBody.indexOf('>', pos);
    if (openingEnd === -1) return undefined;
    const attrs = rowBody.slice(pos + '<td'.length, openingEnd);
    if (/\b(?:colspan|rowspan)\s*=/iu.test(attrs)) return undefined;
    const closing = rowBody.toLowerCase().indexOf('</td>', openingEnd + 1);
    if (closing === -1) return undefined;
    const cellText = rowBody.slice(openingEnd + 1, closing);
    cells.push(cellText.trim().replace(/\s*\n\s*/gu, ' '));
    pos = closing + '</td>'.length;
  }
  return cells;
}

// colgroup の中身は空白と <col ...> （void 要素。閉じタグなし）だけを許可する。
// この検証を欠くと、colgroup 全体を丸ごと読み飛ばす分岐だけが「1文字でも
// 未認識の残りがあれば undefined を返す」という不変条件から外れてしまう。
function isStrictColgroupBody(colgroupBody: string): boolean {
  let pos = 0;
  while (pos < colgroupBody.length) {
    while (pos < colgroupBody.length && /\s/u.test(colgroupBody[pos] ?? ''))
      pos += 1;
    if (pos >= colgroupBody.length) break;
    if (!startsWithTagBoundary(colgroupBody, pos, 'col')) return false;
    const tagEnd = colgroupBody.indexOf('>', pos);
    if (tagEnd === -1) return false;
    pos = tagEnd + 1;
  }
  return true;
}

function parseStrictTable(
  value: string,
): { openingTag: string; rows: string[][] } | undefined {
  const trimmed = value.trim();
  if (!startsWithTagBoundary(trimmed, 0, 'table')) return undefined;
  const openingEnd = trimmed.indexOf('>');
  if (openingEnd === -1) return undefined;
  const openingTag = trimmed.slice(0, openingEnd + 1);
  const closingTag = '</table>';
  const closingStart = trimmed
    .toLowerCase()
    .indexOf(closingTag, openingEnd + 1);
  if (closingStart === -1) return undefined;
  if (trimmed.slice(closingStart + closingTag.length).trim() !== '')
    return undefined;
  const body = trimmed.slice(openingEnd + 1, closingStart);

  const rows: string[][] = [];
  let pos = 0;
  let sawColgroup = false;
  while (pos < body.length) {
    while (pos < body.length && /\s/u.test(body[pos] ?? '')) pos += 1;
    if (pos >= body.length) break;
    if (
      !sawColgroup &&
      rows.length === 0 &&
      startsWithTagBoundary(body, pos, 'colgroup')
    ) {
      const colgroupOpeningEnd = body.indexOf('>', pos);
      if (colgroupOpeningEnd === -1) return undefined;
      const colgroupEnd = body
        .toLowerCase()
        .indexOf('</colgroup>', colgroupOpeningEnd + 1);
      if (colgroupEnd === -1) return undefined;
      if (
        !isStrictColgroupBody(body.slice(colgroupOpeningEnd + 1, colgroupEnd))
      )
        return undefined;
      pos = colgroupEnd + '</colgroup>'.length;
      sawColgroup = true;
      continue;
    }
    if (startsWithTagBoundary(body, pos, 'tr')) {
      const rowOpeningEnd = body.indexOf('>', pos);
      if (rowOpeningEnd === -1) return undefined;
      const rowClosing = body.toLowerCase().indexOf('</tr>', rowOpeningEnd + 1);
      if (rowClosing === -1) return undefined;
      const cells = parseStrictRow(body.slice(rowOpeningEnd + 1, rowClosing));
      if (cells === undefined) return undefined;
      rows.push(cells);
      pos = rowClosing + '</tr>'.length;
      continue;
    }
    return undefined;
  }

  return { openingTag, rows };
}

function tableMarkdown(value: string): string | undefined {
  const parsed = parseStrictTable(value);
  if (parsed === undefined) return undefined;
  const { openingTag, rows } = parsed;

  const columnCount = rows[0]?.length ?? 0;
  if (columnCount === 0 || rows.some((row) => row.length !== columnCount))
    return undefined;

  const hasHeaderRow = attributeValue(openingTag, 'header-row') === 'true';
  return buildMarkdownTableText(rows, hasHeaderRow);
}

// table_of_contents（リネーム後 table-of-contents）はNotion自動生成の目次
// ウィジェットで著者の本文を含まないため、変換ではなく削除する（ADR-006の
// 「未知は保持」方針の例外）。CommonMarkのHTMLブロックは空行まで後続行を
// 吸収するため、自己終了タグの直後（trim後）に本文が続く場合は同じhtml
// ノードにその本文が混入している。安全側に倒し、タグ単体で完結する場合
// （自己終了 `/>` の直後が空白のみ）に限って削除する。
function isTableOfContentsMarkdown(value: string): boolean {
  const trimmed = value.trim();
  const prefix = '<table-of-contents';
  if (!trimmed.toLowerCase().startsWith(prefix)) return false;
  const after = trimmed[prefix.length];
  if (
    after !== '>' &&
    after !== '/' &&
    !(after !== undefined && /\s/u.test(after))
  )
    return false;
  const closingIndex = trimmed.indexOf('>');
  if (closingIndex === -1 || trimmed[closingIndex - 1] !== '/') return false;
  return trimmed.slice(closingIndex + 1).trim() === '';
}

const spanOpenPattern = /^<span\b/iu;

function isSpanOpen(node: RootContent): boolean {
  return node.type === 'html' && spanOpenPattern.test(node.value.trim());
}

function isSpanClose(node: RootContent): boolean {
  return node.type === 'html' && node.value.trim().toLowerCase() === '</span>';
}

// <span color/underline/discussion-urls> をObsidian向けに変換する。開始・終了
// タグが別々のhtmlノードとしてASTに載る（callout等と同様、remarkのinline HTML
// 分割）ため、同一children配列内で開始タグ以降の最初の終了タグをペアとして
// 扱う。ペアが同一配列内に見つからない場合、またはcolor/underline/
// discussion-urlsのいずれも持たない場合（例: class属性のみ）は変換せず元の
// HTMLノードのまま残す（誤って段落境界をまたいだ内容を巻き込まない安全側判定）。
function expandSpans(children: RootContent[]): RootContent[] {
  const result: RootContent[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index]!;
    if (!isSpanOpen(node)) {
      result.push(node);
      index += 1;
      continue;
    }
    let closeIndex = -1;
    for (let cursor = index + 1; cursor < children.length; cursor += 1) {
      if (isSpanClose(children[cursor]!)) {
        closeIndex = cursor;
        break;
      }
    }
    if (closeIndex === -1) {
      result.push(node);
      index += 1;
      continue;
    }
    const openingTag = (node as { value: string }).value.trim();
    const inner = children.slice(index + 1, closeIndex);
    const color = attributeValue(openingTag, 'color');
    const hasUnderline = attributeValue(openingTag, 'underline') === 'true';
    const hasDiscussionUrls =
      attributeValue(openingTag, 'discussion-urls') !== undefined;
    if (color === undefined && !hasUnderline && !hasDiscussionUrls) {
      result.push(node, ...inner, children[closeIndex]!);
    } else {
      let wrapped: RootContent[] = inner;
      if (color !== undefined)
        wrapped = [
          { type: 'html', value: '==' },
          ...wrapped,
          { type: 'html', value: '==' },
        ];
      if (hasUnderline)
        wrapped = [
          { type: 'html', value: '<u>' },
          ...wrapped,
          { type: 'html', value: '</u>' },
        ];
      result.push(...wrapped);
    }
    index = closeIndex + 1;
  }
  return result;
}

function transformParent(parent: Parent): void {
  parent.children = expandSpans(parent.children as RootContent[]);
  const transformed: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    const inline = inlineCallout(child);
    if (inline !== undefined) {
      transformed.push({
        type: 'html',
        value: restoreKnownUnderscoreTags(inline),
      });
      continue;
    }
    const syncedBlockChildren = inlineSyncedBlockChildren(child);
    if (syncedBlockChildren !== undefined) {
      for (const node of syncedBlockChildren)
        restoreUnderscoreTagsDeep(node, restorableHtmlOnlyNodeTypes);
      if (syncedBlockChildren.length > 0)
        transformed.push({ type: 'paragraph', children: syncedBlockChildren });
      continue;
    }
    if (child.type === 'html') {
      if (isTableOfContentsMarkdown(child.value)) continue;
      const callout = calloutMarkdown(child.value);
      if (callout !== undefined) {
        transformed.push({
          type: 'html',
          value: restoreKnownUnderscoreTags(callout),
        });
        continue;
      }
      const columns = columnsMarkdown(child.value);
      if (columns !== undefined) {
        const fragment = unified()
          .use(remarkParse)
          .use(remarkGfm)
          .parse(columns);
        for (const node of fragment.children) restoreUnderscoreTagsDeep(node);
        transformed.push(...fragment.children);
        continue;
      }
      const table = tableMarkdown(child.value);
      if (table !== undefined) {
        const fragment = unified().use(remarkParse).use(remarkGfm).parse(table);
        for (const node of fragment.children) restoreUnderscoreTagsDeep(node);
        transformed.push(...fragment.children);
        continue;
      }
      const syncedBlock = syncedBlockMarkdown(child.value);
      if (syncedBlock !== undefined) {
        const fragment = unified()
          .use(remarkParse)
          .use(remarkGfm)
          .parse(syncedBlock);
        // 中身にcallout等の既存Enhanced Markdown構文が入っていてもそのまま
        // 維持し後段の既存変換が適用されるよう、再帰的に変換する。
        transformParent(fragment);
        for (const node of fragment.children) restoreUnderscoreTagsDeep(node);
        transformed.push(...fragment.children);
        continue;
      }
      transformed.push({
        ...child,
        value: restoreKnownUnderscoreTags(child.value),
      });
      continue;
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
  const normalized = renameKnownUnderscoreTags(markdown);
  return String(await processor.process(normalized));
}
