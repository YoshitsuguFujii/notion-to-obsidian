import type { PhrasingContent, Root, RootContent } from 'mdast';
import type { Parent } from 'unist';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import {
  unicodePunctuation,
  unicodeWhitespace,
} from 'micromark-util-character';
import { buildMarkdownTableText } from './table-markdown.js';
import {
  collectCollapsedCodeRangesDeep,
  extractProtectedRangesForTrailing,
  findCalloutCloseTrailingRange,
  findNestedUnclosedCalloutOpenHtml,
  repairBrokenCodeFences,
  stripPositionsDeep,
  validateProtectedRanges,
  type ProtectedRange,
} from './broken-code-fence.js';

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

// `externalProtectedRanges`は、崩壊コードフェンスのcode本文として
// pre-scan（collectCollapsedCodeRangesDeep）で事前確定した範囲。
// code/inlineCodeノードとして未認識のため`collectUneditableRanges`の
// 除外範囲に含まれないが、pre-parse正規化の対象外とする必要がある
// （「code本文は元のNotion Markdownと完全一致する」という不変条件）。
// この関数はアンダースコア→ハイフンの1文字対1文字置換のみで文字数を
// 変えないため、呼び出し元は戻り値の文字列に対して同じoffsetの
// 保護範囲をそのまま再利用できる。
function renameKnownUnderscoreTags(
  markdown: string,
  externalProtectedRanges: readonly Range[],
): string {
  if (!knownUnderscoreTagNames.some((name) => markdown.includes(name)))
    return markdown;
  let uneditableRanges: Range[];
  try {
    uneditableRanges = [
      ...collectUneditableRanges(markdown),
      ...externalProtectedRanges,
    ];
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

const ZERO_WIDTH_SPACE = '\u200B';

// CommonMarkのflanking規則では、`**`の直後が（Unicode）句読点かつ直前が
// 空白・句読点でない場合、開始デリミタになれずエスケープされる
// （例: 「限り**、実行時に...**」の1つ目の**）。micromarkが実際の判定に
// 使うunicodePunctuation/unicodeWhitespaceをそのまま再利用し、判定基準の
// ズレによる誤検出を避ける。該当箇所の`**`直後にU+200B（ゼロ幅スペース）
// を挿入し、直後の文字を句読点以外に見せることでleft-flankingを成立させる。
// U+200Bはstringify後に除去する（removeZeroWidthSpaces）。
interface BoldFlankingResult {
  text: string;
  adjustedProtectedRanges: Range[];
}

// U+200B挿入は文字数を増やすため、挿入位置より後ろの保護範囲offsetは
// ズレる。挿入位置リスト（元markdown基準、昇順）を使い、offset以下の
// 挿入位置の個数だけシフトした新しいoffsetを計算する。
function adjustOffsetForInsertions(
  offset: number,
  insertionPoints: readonly number[],
): number {
  let shift = 0;
  for (const point of insertionPoints) {
    if (point <= offset) shift += 1;
    else break;
  }
  return offset + shift;
}

// `externalProtectedRanges`（pre-scanで確定した崩壊code本文の範囲、
// renameKnownUnderscoreTags適用後も同じoffset）内の`**`はU+200B挿入
// 対象から除外する。挿入によって後続offsetがズレるため、戻り値では
// externalProtectedRangesをズレた分だけ調整した新しいoffsetで返す
// （呼び出し元がこれをrepairBrokenCodeFencesの本修復判定に使う）。
function insertZeroWidthSpaceForBoldFlanking(
  markdown: string,
  externalProtectedRanges: readonly Range[],
): BoldFlankingResult {
  if (!markdown.includes('**'))
    return {
      text: markdown,
      adjustedProtectedRanges: [...externalProtectedRanges],
    };
  let uneditableRanges: Range[];
  try {
    uneditableRanges = [
      ...collectUneditableRanges(markdown),
      ...externalProtectedRanges,
    ];
  } catch {
    return {
      text: markdown,
      adjustedProtectedRanges: [...externalProtectedRanges],
    };
  }
  const insertionPoints: number[] = [];
  for (const match of markdown.matchAll(/\*\*/gu)) {
    const index = match.index;
    if (isWithinRange(index, uneditableRanges)) continue;
    const afterChar = markdown[index + 2];
    if (
      afterChar === undefined ||
      !unicodePunctuation(afterChar.codePointAt(0)!)
    )
      continue;
    const beforeChar = index > 0 ? markdown[index - 1] : undefined;
    if (beforeChar === undefined) continue;
    const beforeCode = beforeChar.codePointAt(0)!;
    if (unicodeWhitespace(beforeCode) || unicodePunctuation(beforeCode))
      continue;
    insertionPoints.push(index + 2);
  }
  if (insertionPoints.length === 0)
    return {
      text: markdown,
      adjustedProtectedRanges: [...externalProtectedRanges],
    };
  // 防御的チェック: isWithinRangeによる除外が正しく機能していれば
  // 到達しない想定だが、万一保護範囲の内部（半開区間[start, end)）へ
  // 挿入しようとしていた場合は実装のバグとみなし、補正全体を中止して
  // 未変更のmarkdownを返す（code本文を書き換えるより安全）。
  const insertedIntoProtectedRange = insertionPoints.some((point) =>
    externalProtectedRanges.some(
      (range) => point >= range.start && point < range.end,
    ),
  );
  if (insertedIntoProtectedRange)
    return {
      text: markdown,
      adjustedProtectedRanges: [...externalProtectedRanges],
    };
  let result = '';
  let cursor = 0;
  for (const point of insertionPoints) {
    result += markdown.slice(cursor, point) + ZERO_WIDTH_SPACE;
    cursor = point;
  }
  const text = result + markdown.slice(cursor);
  const adjustedProtectedRanges = externalProtectedRanges.map((range) => ({
    start: adjustOffsetForInsertions(range.start, insertionPoints),
    end: adjustOffsetForInsertions(range.end, insertionPoints),
  }));
  return { text, adjustedProtectedRanges };
}

function removeZeroWidthSpaces(value: string): string {
  return value.replaceAll(ZERO_WIDTH_SPACE, '');
}

// removeZeroWidthSpacesはstringify後のU+200Bを無条件に除去するため、
// pre-parse正規化（insertZeroWidthSpaceForBoldFlanking）が挿入した分だけ
// でなく、Notion本文に著者が元から書いていたU+200Bも区別なく削除して
// しまう（安全不変条件8「黙って情報を捨てない」に抵触）。パイプライン
// 先頭で既存のU+200Bを衝突しないsentinel（Private Use Areaの1文字）へ
// 一時退避し、removeZeroWidthSpaces適用後に元へ復元することで、挿入分
// のみを除去対象にする。単一固定文字だと、その文字自体が本文に既に
// 含まれる場合に退避できず全除去にフォールバックしてしまうため、
// 複数候補から入力に含まれない文字を動的に選ぶ。
const ZERO_WIDTH_SPACE_SENTINEL_CANDIDATES = Array.from(
  { length: 16 },
  (_, index) => String.fromCharCode(0xe000 + index),
);

interface ZeroWidthSpaceEscapeResult {
  text: string;
  sentinel: string | undefined;
}

function pickUnusedSentinel(markdown: string): string | undefined {
  return ZERO_WIDTH_SPACE_SENTINEL_CANDIDATES.find(
    (candidate) => !markdown.includes(candidate),
  );
}

// 全候補が本文に既に含まれる場合（極めて低頻度）は区別できないため
// 退避自体を行わず、既存挙動（全除去）にフォールバックする。
function escapeExistingZeroWidthSpaces(
  markdown: string,
): ZeroWidthSpaceEscapeResult {
  if (!markdown.includes(ZERO_WIDTH_SPACE))
    return { text: markdown, sentinel: undefined };
  const sentinel = pickUnusedSentinel(markdown);
  if (sentinel === undefined) return { text: markdown, sentinel: undefined };
  return {
    text: markdown.replaceAll(ZERO_WIDTH_SPACE, sentinel),
    sentinel,
  };
}

// escapeExistingZeroWidthSpacesが退避を行わなかった場合（U+200Bが元々
// 無い、または全sentinel候補が本文と衝突するため退避を諦めた場合）、
// 呼び出し元は`sentinel`がundefinedのままこの関数を呼ばない。本文中に
// 元から含まれていたsentinel文字を誤ってU+200Bへ書き換えないため。
function restoreEscapedZeroWidthSpaces(
  value: string,
  sentinel: string,
): string {
  return value.replaceAll(sentinel, ZERO_WIDTH_SPACE);
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

interface SyncedBlockExpansion {
  body: string;
  trailing: string;
}

interface SyncedBlockRange {
  bodyStart: number;
  closingStart: number;
  closingEnd: number;
}

function htmlTagEnd(value: string, tagStart: number): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = tagStart + 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return undefined;
}

function hasTagNameBoundary(value: string, nameEnd: number): boolean {
  const after = value[nameEnd];
  return after === '>' || after === '/' || /\s/u.test(after ?? '');
}

function hasCaseInsensitivePrefixAt(
  value: string,
  prefix: string,
  start: number,
): boolean {
  return value.slice(start, start + prefix.length).toLowerCase() === prefix;
}

// CommonMarkのHTMLブロックが後続の同名要素まで吸収しても、先頭の
// synced_blockと対応する閉じタグだけを境界として使う。同名要素の入れ子は
// 深さで追跡し、コード内のタグ状文字列や壊れたタグで対応関係を証明できない
// 場合は、内容を誤って分割するより元のHTMLを保持する。
function matchingSyncedBlockRange(value: string): SyncedBlockRange | undefined {
  const tagName = 'synced-block';
  const openingPrefix = `<${tagName}`;
  const closingPrefix = `</${tagName}`;
  if (
    !hasCaseInsensitivePrefixAt(value, openingPrefix, 0) ||
    !hasTagNameBoundary(value, openingPrefix.length)
  )
    return undefined;
  const openingEnd = htmlTagEnd(value, 0);
  if (
    openingEnd === undefined ||
    value.slice(0, openingEnd).trimEnd().endsWith('/')
  )
    return undefined;

  let uneditableRanges: Range[];
  try {
    uneditableRanges = collectUneditableRanges(value.slice(openingEnd + 1)).map(
      (range) => ({
        start: range.start + openingEnd + 1,
        end: range.end + openingEnd + 1,
      }),
    );
  } catch {
    return undefined;
  }

  let depth = 1;
  let cursor = openingEnd + 1;
  while (cursor < value.length) {
    const tagStart = value.indexOf('<', cursor);
    if (tagStart === -1) return undefined;
    const uneditableRange = uneditableRanges.find(
      (range) => tagStart >= range.start && tagStart < range.end,
    );
    if (uneditableRange !== undefined) {
      cursor = uneditableRange.end;
      continue;
    }

    if (value.startsWith('<!--', tagStart)) {
      const commentEnd = value.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) return undefined;
      cursor = commentEnd + 3;
      continue;
    }
    if (hasCaseInsensitivePrefixAt(value, '<![cdata[', tagStart)) {
      const cdataEnd = value.indexOf(']]>', tagStart + 9);
      if (cdataEnd === -1) return undefined;
      cursor = cdataEnd + 3;
      continue;
    }

    const marker = value[tagStart + 1];
    const nameStart = marker === '/' ? tagStart + 2 : tagStart + 1;
    if (!/[A-Za-z]/u.test(value[nameStart] ?? '')) {
      const isDeclaration = marker === '!' || marker === '?';
      if (!isDeclaration) {
        cursor = tagStart + 1;
        continue;
      }
    }

    const tagEnd = htmlTagEnd(value, tagStart);
    if (tagEnd === undefined) return undefined;

    const isClosing = hasCaseInsensitivePrefixAt(
      value,
      closingPrefix,
      tagStart,
    );
    const isOpening = hasCaseInsensitivePrefixAt(
      value,
      openingPrefix,
      tagStart,
    );
    const prefix = isClosing
      ? closingPrefix
      : isOpening
        ? openingPrefix
        : undefined;
    if (prefix === undefined) {
      cursor = tagEnd + 1;
      continue;
    }
    const nameEnd = tagStart + prefix.length;
    if (!hasTagNameBoundary(value, nameEnd)) {
      cursor = tagEnd + 1;
      continue;
    }

    if (isClosing) {
      if (value.slice(nameEnd, tagEnd).trim() !== '') return undefined;
      depth -= 1;
      if (depth === 0)
        return {
          bodyStart: openingEnd + 1,
          closingStart: tagStart,
          closingEnd: tagEnd + 1,
        };
    } else if (!value.slice(tagStart, tagEnd).trimEnd().endsWith('/')) {
      depth += 1;
    }
    cursor = tagEnd + 1;
  }
  return undefined;
}

// Notionの同期ブロック（synced_block、リネーム後synced-block）は、複数箇所に
// 同一内容を複製表示するUI機能であり、片方向ミラーであるObsidian側では
// 複製元・複製先の区別に意味が無い。タグを外し中身をそのまま段落として残す。
// url属性は開始タグ側にありbody抽出の対象外なので、リンクとして誤認識される
// ことはない。
//
// HTMLブロックは空行まで後続行を吸収するため、閉じタグ直後（空行なし）に
// 本文が続く場合、その本文（trailing）も同じノードのvalueに混入する。
// 従来は展開自体を諦めるfail-closedだったが（trailingを失わないための
// 安全策）、実データでこの巻き込みが数KB規模の後続コンテンツ全体
// （別のリスト・コードフェンス等）を丸ごと生HTMLのまま出力する重大な
// 表示崩れを引き起こすことが判明した。Phase 10/11のcallout trailing
// 処理と同型のパターンで、trailingを分離して呼び出し元で独立に
// 再parse・修復する設計へ変更した（Phase 12）。
function syncedBlockMarkdown(value: string): SyncedBlockExpansion | undefined {
  const trimmed = value.trim();
  const range = matchingSyncedBlockRange(trimmed);
  if (range === undefined) return undefined;
  const body = trimmed.slice(range.bodyStart, range.closingStart).trim();
  const trailing = trimmed.slice(range.closingEnd).replace(/^\r?\n/u, '');
  return { body, trailing };
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

// CommonMarkのHTMLブロックは空行まで後続行を吸収するため、単独行の
// `<span ...>`の直後（空行なし）に本文が続く場合、同じhtmlノードの
// valueにその本文が混入する（table_of_contents/synced_blockと同型の
// 問題）。タグ単体で完結する場合（trim後の値が開始タグの`>`で終わる
// 場合）に限ってspan開始として扱い、そうでなければ安全側に倒して
// 通常のhtmlノードとして素通しする。
function isSpanOpen(node: RootContent): boolean {
  if (node.type !== 'html') return false;
  const trimmed = node.value.trim();
  if (!spanOpenPattern.test(trimmed)) return false;
  const closingBracket = trimmed.indexOf('>');
  return closingBracket !== -1 && closingBracket === trimmed.length - 1;
}

function isSpanClose(node: RootContent): boolean {
  return node.type === 'html' && node.value.trim().toLowerCase() === '</span>';
}

function findSpanCloseIndex(
  children: readonly RootContent[],
  fromIndex: number,
): number {
  for (let cursor = fromIndex; cursor < children.length; cursor += 1) {
    if (isSpanClose(children[cursor]!)) return cursor;
  }
  return -1;
}

// color/underline/discussion-urls属性に応じてspanの中身を変換する。
// いずれも持たない場合（例: class属性のみ）はundefinedを返し、
// 呼び出し側で元のHTMLノードをそのまま残す判断に使う。
function transformSpanContent(
  openingTag: string,
  inner: readonly RootContent[],
): RootContent[] | undefined {
  const color = attributeValue(openingTag, 'color');
  const hasUnderline = attributeValue(openingTag, 'underline') === 'true';
  const hasDiscussionUrls =
    attributeValue(openingTag, 'discussion-urls') !== undefined;
  if (color === undefined && !hasUnderline && !hasDiscussionUrls)
    return undefined;
  // 中身が空の場合、`==`/`<u>`同士が隣接するだけの無意味な出力
  // （例: `====`）になるため、何も残さない（安全不変条件8には
  // 反しない。空synced_blockの既存挙動と同じ扱い）。
  if (inner.length === 0) return [];
  let wrapped: RootContent[] = [...inner];
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
  return wrapped;
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
    const closeIndex = findSpanCloseIndex(children, index + 1);
    if (closeIndex === -1) {
      result.push(node);
      index += 1;
      continue;
    }
    const inner = children.slice(index + 1, closeIndex);
    const openingTag = (node as { value: string }).value.trim();
    const transformed = transformSpanContent(openingTag, inner);
    result.push(...(transformed ?? [node, ...inner, children[closeIndex]!]));
    index = closeIndex + 1;
  }
  return result;
}

// paragraph内でinline HTMLとして存在する<callout>開始タグが、本文中の
// 空行によりCommonMarkのHTMLブロック規則で閉じタグ</callout>と別ノードに
// 分裂した場合を検出する。paragraph内の開始タグ以降の子ノードがすべて
// text型であることを要求する（他の型が混ざる場合は安全側で対象外とし、
// 呼び出し側で元のまま出力する）。
function unclosedCalloutOpenParagraph(node: RootContent):
  | {
      openingTag: string;
      before: PhrasingContent[];
      bodyPrefix: string;
    }
  | undefined {
  if (node.type !== 'paragraph') return undefined;
  const children = node.children;
  const openIndex = children.findIndex(
    (child) =>
      child.type === 'html' &&
      child.value.trim().toLowerCase().startsWith('<callout'),
  );
  if (openIndex === -1) return undefined;
  const openNode = children[openIndex]!;
  if (openNode.type !== 'html') return undefined;
  const rest = children.slice(openIndex);
  if (
    rest.some(
      (child) =>
        child.type === 'html' &&
        child.value.toLowerCase().includes('</callout>'),
    )
  )
    return undefined;
  const after = children.slice(openIndex + 1);
  if (!after.every((child) => child.type === 'text')) return undefined;
  const openingTag = openNode.value.trim();
  const bodyPrefix = after
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('');
  return { openingTag, before: children.slice(0, openIndex), bodyPrefix };
}

// html型ノードのvalueに含まれる</callout>で分割する。含まない場合は
// undefinedを返す（このノードは終了ノードの候補ではない）。
function splitAtCalloutClose(
  value: string,
): { before: string; after: string } | undefined {
  const closeTag = '</callout>';
  const index = value.toLowerCase().indexOf(closeTag);
  if (index === -1) return undefined;
  return {
    before: value.slice(0, index),
    after: value.slice(index + closeTag.length),
  };
}

const calloutFragmentProcessor = unified().use(remarkParse).use(remarkGfm);

// 開始タグと終了タグが空行を挟んで別ノードに分裂したcalloutを結合する。
// 開始paragraphの直後の兄弟ノードのみを終了候補として扱う（間に他の
// ノードが挟まる場合、または直後のノードがhtml型でない場合は対象外とし
// 変換しない安全側判定）。終了ノードが後続本文を巻き込んでいる場合
// （CommonMarkのHTMLブロックが次の空行まで後続行を巻き込む挙動）、その
// 本文を生Markdown文字列として再parseし、結合したcalloutの直後へ復元する。
//
// 巻き込まれた本文（trailing）自体に崩壊コードフェンスがネストしている
// 場合（Phase 10、実データで確認）、pre-scan（broken-code-fence.tsの
// collectCollapsedCodeRanges）が同じcallout分裂パターンを辿って事前に
// 検出した保護範囲（`protectedRanges`）をtrailing相対offsetへ変換して
// `repairBrokenCodeFences`を再帰適用する（broken-code-fence.ts自身の
// trailing処理と同型のパターン）。offset計算に失敗した場合（通常到達
// しない想定）は、修復を諦めて従来どおりparseのみ行う（fail-closed。
// 情報損失にはならない）。
function joinSplitCallouts(
  children: RootContent[],
  sourceText: string,
  protectedRanges: readonly ProtectedRange[],
): RootContent[] {
  const result: RootContent[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index]!;
    // リスト境界をまたぐcallout分裂（Phase 11）: 開始<callout>タグが
    // リストの最後のlistItemの最後の子としてhtmlノードで存在し、対応
    // する</callout>がそのリスト自体の直後の兄弟ノードとして出現する
    // ケース。CommonMarkのHTML block吸収がlistItem/listのコンテナ境界を
    // 越えて継続するため、開始側と終了側が異なるchildren配列に分裂する
    // （開始paragraph・終了htmlが同一children配列内に隣接する通常の
    // callout分裂とは別パターン。実データで確認済み）。
    if (node.type === 'list') {
      const nestedOpen = findNestedUnclosedCalloutOpenHtml(node);
      const nextSibling = children[index + 1];
      const openStart = nestedOpen?.position?.start.offset;
      const openEnd = nestedOpen?.position?.end.offset;
      const closeRange =
        nestedOpen !== undefined && nextSibling?.type === 'html'
          ? findCalloutCloseTrailingRange(sourceText, nextSibling)
          : undefined;
      const closeStart = nextSibling?.position?.start.offset;
      if (
        nestedOpen !== undefined &&
        nextSibling !== undefined &&
        closeRange !== undefined &&
        openStart !== undefined &&
        openEnd !== undefined &&
        closeStart !== undefined
      ) {
        const lastItem = node.children.at(-1)!;
        const remainingChildren = lastItem.children.slice(0, -1);
        const remainingItems =
          remainingChildren.length > 0
            ? [
                ...node.children.slice(0, -1),
                { ...lastItem, children: remainingChildren },
              ]
            : node.children.slice(0, -1);
        if (remainingItems.length > 0)
          result.push({ ...node, children: remainingItems });
        const combined =
          sourceText.slice(openStart, openEnd) +
          '\n' +
          sourceText.slice(closeStart, closeRange.closeTagEnd);
        result.push({ type: 'html', value: combined });
        const trailing = sourceText.slice(
          closeRange.trailingStart,
          closeRange.trailingEnd,
        );
        if (trailing.length > 0) {
          try {
            const fragment = calloutFragmentProcessor.parse(trailing);
            const trailingProtectedRanges = validateProtectedRanges(
              extractProtectedRangesForTrailing(
                protectedRanges,
                closeRange.trailingStart,
                trailing.length,
              ),
              trailing.length,
            );
            fragment.children = repairBrokenCodeFences(
              fragment.children,
              trailing,
              trailingProtectedRanges,
            );
            for (const fragmentChild of fragment.children)
              stripPositionsDeep(fragmentChild);
            result.push(...fragment.children);
          } catch {
            // remark-parseは通常どのような文字列に対しても例外を投げない
            // ため実行時には到達しない想定だが、中途半端に結合するより
            // 安全側に倒し、このcalloutは結合せず元のノードを維持する
            // フォールバックとして残す（他のtrailing処理と同型パターン）。
            result.push(node, nextSibling);
            index += 2;
            continue;
          }
        }
        index += 2;
        continue;
      }
    }
    const openInfo = unclosedCalloutOpenParagraph(node);
    const nextNode = children[index + 1];
    if (openInfo === undefined || nextNode?.type !== 'html') {
      result.push(node);
      index += 1;
      continue;
    }
    const closeInfo = splitAtCalloutClose(nextNode.value);
    if (closeInfo === undefined) {
      result.push(node);
      index += 1;
      continue;
    }
    const { before } = openInfo;
    if (before.length > 0) {
      const lastBefore = before[before.length - 1]!;
      if (lastBefore.type === 'text')
        lastBefore.value = lastBefore.value.replace(/\r?\n$/u, '');
      result.push({ type: 'paragraph', children: before });
    }
    const combined = `${openInfo.openingTag}${openInfo.bodyPrefix}${closeInfo.before}\n</callout>`;
    result.push({ type: 'html', value: combined });
    const trailingRange = findCalloutCloseTrailingRange(sourceText, nextNode);
    const trailing =
      trailingRange !== undefined
        ? sourceText.slice(
            trailingRange.trailingStart,
            trailingRange.trailingEnd,
          )
        : closeInfo.after.replace(/^\r?\n/u, '');
    if (trailing.length > 0) {
      try {
        const fragment = calloutFragmentProcessor.parse(trailing);
        if (trailingRange !== undefined) {
          const trailingProtectedRanges = validateProtectedRanges(
            extractProtectedRangesForTrailing(
              protectedRanges,
              trailingRange.trailingStart,
              trailing.length,
            ),
            trailing.length,
          );
          fragment.children = repairBrokenCodeFences(
            fragment.children,
            trailing,
            trailingProtectedRanges,
          );
        }
        for (const fragmentChild of fragment.children)
          stripPositionsDeep(fragmentChild);
        result.push(...fragment.children);
      } catch {
        // remark-parseは通常どのような文字列に対しても例外を投げないため
        // 実行時には到達しない想定だが、中途半端に結合するより安全側に
        // 倒し、このcalloutは結合せず元のノードを維持するフォールバック
        // として残す（repairBrokenCodeFencesの同型パターンを踏襲）。
        result.push(node, nextNode);
        index += 2;
        continue;
      }
    }
    index += 2;
  }
  return result;
}

function transformParent(
  parent: Parent,
  sourceText: string,
  protectedRanges: readonly ProtectedRange[],
): void {
  parent.children = expandSpans(parent.children as RootContent[]);
  parent.children = repairBrokenCodeFences(
    parent.children as RootContent[],
    sourceText,
    protectedRanges,
  );
  parent.children = joinSplitCallouts(
    parent.children as RootContent[],
    sourceText,
    protectedRanges,
  );
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
          .parse(syncedBlock.body);
        // 中身にcallout等の既存Enhanced Markdown構文が入っていてもそのまま
        // 維持し後段の既存変換が適用されるよう、再帰的に変換する。
        // fragmentはsyncedBlock.body文字列を独立に再parseしたものなので、
        // 位置オフセットの基準もbody自身になる。pre-scanは元文書全体に
        // 対してのみ行っており、body文字列自体のoffset基準には対応しない
        // ため、空配列を渡す（内部で崩壊コードフェンスが検出されても
        // fail-closedとなる。既知の制約）。
        transformParent(fragment, syncedBlock.body, []);
        for (const node of fragment.children) restoreUnderscoreTagsDeep(node);
        transformed.push(...fragment.children);
        // 閉じタグ直後（空行なし）に巻き込まれた後続本文（trailing）は、
        // Phase 10/11のcallout trailing処理と同型のパターンで扱う。
        // trailingは独立した文字列のため、その基準でpre-scanを行い
        // （collectCollapsedCodeRangesDeep）、崩壊コードフェンスの保護
        // 範囲を確定してから修復する（外側のprotectedRangesとは独立）。
        if (syncedBlock.trailing.length > 0) {
          try {
            const trailingFragment = unified()
              .use(remarkParse)
              .use(remarkGfm)
              .parse(syncedBlock.trailing);
            const trailingProtectedRanges = validateProtectedRanges(
              collectCollapsedCodeRangesDeep(
                trailingFragment,
                syncedBlock.trailing,
              ),
              syncedBlock.trailing.length,
            );
            trailingFragment.children = repairBrokenCodeFences(
              trailingFragment.children,
              syncedBlock.trailing,
              trailingProtectedRanges,
            );
            transformParent(
              trailingFragment,
              syncedBlock.trailing,
              trailingProtectedRanges,
            );
            for (const node of trailingFragment.children) {
              restoreUnderscoreTagsDeep(node);
              stripPositionsDeep(node);
            }
            transformed.push(...trailingFragment.children);
          } catch {
            // remark-parseは通常どのような文字列に対しても例外を投げない
            // ため実行時には到達しない想定だが、中途半端に変換するより
            // 安全側に倒し、trailingは生文字列のまま段落として保全する
            // （情報損失にはならない）。
            transformed.push({
              type: 'paragraph',
              children: [{ type: 'text', value: syncedBlock.trailing }],
            });
          }
        }
        continue;
      }
      transformed.push({
        ...child,
        value: restoreKnownUnderscoreTags(child.value),
      });
      continue;
    }
    if ('children' in child && Array.isArray(child.children)) {
      transformParent(child, sourceText, protectedRanges);
    }
    transformed.push(child);
  }
  parent.children = transformed;
}

// processorはprotectedRangesを呼び出しごとに変えて注入する必要があるため、
// グローバルな単一インスタンスではなくtransformEnhancedMarkdown呼び出し
// ごとに構築する。remark pluginは`.use(plugin, options)`の形で静的な
// optionsしか受け取れないため、クロージャでprotectedRangesを渡す。
function buildProcessor(protectedRanges: readonly ProtectedRange[]) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: Root, file: { toString(): string }) => {
      transformParent(tree, String(file), protectedRanges);
    })
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      listItemIndent: 'one',
      rule: '-',
    });
}

export async function transformEnhancedMarkdown(
  markdown: string,
): Promise<string> {
  const { text: escaped, sentinel } = escapeExistingZeroWidthSpaces(markdown);
  // 全sentinel候補（U+E000〜U+E00F）が本文と衝突し、既存のU+200Bを
  // 退避できなかった場合（極めて低頻度）、著者記述のU+200Bと太字
  // flanking補正で挿入するU+200Bを区別できない。太字補正の挿入・
  // stringify後の除去の両方をスキップし、著者記述のU+200Bを完全に
  // 保持する（安全不変条件8「黙って情報を捨てない」を優先し、太字
  // 補正を諦める方を選ぶ。以前は全除去にフォールバックしていたが、
  // これは著者記述のU+200Bまで削除してしまうため不採用に変更した）。
  const hasUnprotectableZeroWidthSpace =
    sentinel === undefined && markdown.includes(ZERO_WIDTH_SPACE);
  // pre-parse正規化（rename/U+200B挿入）は、code/inlineCodeノードとして
  // 未認識の崩壊コードフェンスのcode本文を書き換えてしまいうる。正規化
  // より前のescaped markdownに対してpre-scanを行い、崩壊code本文の範囲を
  // 事前確定し、正規化の除外範囲へ加える（「code本文は元のNotion
  // Markdownと完全一致する」という不変条件を維持するため）。整合性が
  // 崩れているrangeが1件でもあればpre-scan全体をfail-closedとする。
  const initialProtectedRanges = validateProtectedRanges(
    collectCollapsedCodeRangesDeep(parseOnlyProcessor.parse(escaped), escaped),
    escaped.length,
  );
  const renamed = renameKnownUnderscoreTags(escaped, initialProtectedRanges);
  const { text: normalized, adjustedProtectedRanges: rawAdjustedRanges } =
    hasUnprotectableZeroWidthSpace
      ? {
          text: renamed,
          adjustedProtectedRanges: initialProtectedRanges,
        }
      : insertZeroWidthSpaceForBoldFlanking(renamed, initialProtectedRanges);
  const adjustedProtectedRanges = validateProtectedRanges(
    rawAdjustedRanges,
    normalized.length,
  );
  const processor = buildProcessor(adjustedProtectedRanges);
  const result = String(await processor.process(normalized));
  const withoutInsertedZeroWidthSpaces = hasUnprotectableZeroWidthSpace
    ? result
    : removeZeroWidthSpaces(result);
  return sentinel !== undefined
    ? restoreEscapedZeroWidthSpaces(withoutInsertedZeroWidthSpaces, sentinel)
    : withoutInsertedZeroWidthSpaces;
}
