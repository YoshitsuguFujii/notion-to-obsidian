import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { stableReferenceUrl } from './stable-url.js';

// 構文別に置換 span を確定した経路のタグ。Plan/Apply比較で「同じ件数でも別の構文分類から
// 置換された」ケースを検出するために使う（本文中の位置は Plan/Apply 間でアセット処理の
// 影響を受けてずれうるため、offset ではなく構文分類を比較対象に含める）。
export type ReplacementContext =
  | 'markdown-link'
  | 'markdown-image'
  | 'autolink'
  | 'html-attribute'
  | 'html-rescue';

// 裸URLの走査は特定の構文ノードに紐づかないため、専用の 'bare-url' を割り当てる。
export type UnsafeOccurrenceContext = ReplacementContext | 'bare-url';

export interface Replacement {
  // Plan/Apply比較（fingerprintSetsMatch）では使わない（offsetはアセット処理で
  // 正当にずれうるため）。診断・将来のツール向けに元の出現位置を保持する。
  start: number;
  end: number;
  sourceHash: string;
  replacement: string;
  context: ReplacementContext;
}

export interface UnsafeOccurrence {
  sourceHash: string;
  reason: 'boundary-undetermined' | 'unparseable';
  context: UnsafeOccurrenceContext;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ReplacementFingerprint {
  sourceHash: string;
  replacement: string;
  context: ReplacementContext;
}

function toFingerprint({
  sourceHash,
  replacement,
  context,
}: Replacement): ReplacementFingerprint {
  return { sourceHash, replacement, context };
}

interface UnsafeFingerprint {
  sourceHash: string;
  reason: 'boundary-undetermined' | 'unparseable';
  context: UnsafeOccurrenceContext;
}

function toUnsafeFingerprint({
  sourceHash,
  reason,
  context,
}: UnsafeOccurrence): UnsafeFingerprint {
  return { sourceHash, reason, context };
}

// offset は Plan/Apply 間でアセット処理により正当にずれうるため比較に使わない。
// 同じ署名URLが複数回現れる場合を区別できるよう、多重集合として（重複を保持したまま）
// 決定論的にソートして比較する。
function canonicalize<T>(
  items: readonly T[],
  toFingerprintOf: (item: T) => unknown,
): string[] {
  return items.map((item) => JSON.stringify(toFingerprintOf(item))).sort();
}

function fingerprintSetsMatch<T>(
  left: readonly T[],
  right: readonly T[],
  toFingerprintOf: (item: T) => unknown,
): boolean {
  const leftCanonical = canonicalize(left, toFingerprintOf);
  const rightCanonical = canonicalize(right, toFingerprintOf);
  if (leftCanonical.length !== rightCanonical.length) return false;
  return leftCanonical.every((value, index) => value === rightCanonical[index]);
}

// Plan で確定した置換内容と Apply で再計算した置換内容が一致するかを検証する。
// 件数だけの比較では「同じ件数だが別のURLを置換した」を検出できないため、
// 置換元URLのhash・置換後の値・構文分類の多重集合を比較する。
export function replacementsMatch(
  left: readonly Replacement[],
  right: readonly Replacement[],
): boolean {
  return fingerprintSetsMatch(left, right, toFingerprint);
}

// Plan/Apply間で安全停止対象（境界未確定・解析不能）の集合が変わっていないかを検証する。
// 件数だけの比較では、同数でも異なるURLが安全停止対象になったケースを見逃す。
export function unsafeOccurrencesMatch(
  left: readonly UnsafeOccurrence[],
  right: readonly UnsafeOccurrence[],
): boolean {
  return fingerprintSetsMatch(left, right, toUnsafeFingerprint);
}

interface DestinationToken {
  start: { offset: number };
  end: { offset: number };
}

// link / image ノードの destination token の位置。parse 中に enter.resourceDestination
// を通じて収集する。`](` の記号列を探す推測ではなく、parser が確定した destination の
// 位置そのものを使う。単一スレッド・同期呼び出しの前提で、parse 呼び出しのたびにリセットする。
let destinationTokenSpans: UrlSpan[] = [];

function collectDestinationTokens(this: {
  data: (key: string) => unknown;
}): void {
  const data = this.data('fromMarkdownExtensions') as unknown[] | undefined;
  const extensions = data ?? [];
  extensions.push({
    enter: {
      resourceDestination(token: DestinationToken): void {
        destinationTokenSpans.push({
          start: token.start.offset,
          end: token.end.offset,
        });
      },
    },
  });
  (this as unknown as { data: (key: string, value: unknown) => void }).data(
    'fromMarkdownExtensions',
    extensions,
  );
}

// parse だけを行い stringify はしない。AGENTS.md が禁じるのは round-trip による
// WikiLink 等の破壊であり、位置情報の取得だけなら本文へ影響しない。
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(collectDestinationTokens);

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

const signatureParameters = new Set(
  [
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Amz-Algorithm',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-SignedHeaders',
    'X-Amz-Security-Token',
    'AWSAccessKeyId',
    'Signature',
    'Expires',
    'expirationTimestamp',
  ].map((name) => name.toLowerCase()),
);

export interface SignedUrlReplacementResult {
  markdown: string;
  replacedCount: number;
  boundaryUndeterminedCount: number;
  unparseableSignedUrlCount: number;
  replacements: Replacement[];
  unsafe: UnsafeOccurrence[];
}

function isDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isRegionalS3Host(hostname: string): boolean {
  return /^s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(hostname);
}

function isNotionAssetLocation(hostname: string, pathname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, '');
  if (
    isDomain(normalizedHostname, 'notion.so') ||
    isDomain(normalizedHostname, 'notion-static.com')
  )
    return true;
  if (
    normalizedHostname === 'prod-files-secure.s3.amazonaws.com' ||
    /^prod-files-secure\.s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(
      normalizedHostname,
    )
  )
    return true;
  if (
    normalizedHostname !== 's3.amazonaws.com' &&
    !isRegionalS3Host(normalizedHostname)
  )
    return false;
  return /^\/secure\.notion-static\.com(?:\/|[?#]|$)/iu.test(pathname);
}

function isNotionAssetHost(url: URL): boolean {
  return isNotionAssetLocation(url.hostname, url.pathname);
}

function hasSignatureParameter(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (signatureParameters.has(name.toLowerCase())) return true;
  }
  return false;
}

// HTML 上の `&` は実体参照でも書ける。query の区切りを見落とすと署名parameterを検出できない。
function decodeAmpersands(query: string): string {
  return query.replace(/&(?:amp|#0*38|#x0*26);/giu, '&');
}

// 実体参照は `#` を含むため、query と fragment を切り分ける前に decode する必要がある。
// `&#x26;` の `#` を fragment の開始と誤認すると、以降の署名parameterを見落とす。
// path は decode しない。実体参照を解いた path を安定参照として保存すると、
// 元の Markdown に書かれていた文字列と異なる path を出力してしまう。
function classificationValue(value: string): string {
  const queryStart = value.indexOf('?');
  if (queryStart < 0) return value;
  return `${value.slice(0, queryStart + 1)}${decodeAmpersands(
    value.slice(queryStart + 1),
  )}`;
}

function hasClassifiedSignatureParameter(value: string): boolean {
  const normalized = classificationValue(value);
  const queryStart = normalized.indexOf('?');
  if (queryStart < 0) return false;
  const query = normalized.slice(queryStart + 1).split('#', 1)[0]!;
  return query.split('&').some((part) => {
    const rawName = part.split('=', 1)[0]!;
    try {
      return signatureParameters.has(decodeURIComponent(rawName).toLowerCase());
    } catch {
      return signatureParameters.has(rawName.toLowerCase());
    }
  });
}

function rawKnownNotionAssetHost(value: string): boolean {
  const match = /^(https?):\/\/([^/?#]*)/iu.exec(value);
  if (!match) return false;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  if (
    authority.length === 0 ||
    authority.includes('@') ||
    authority.includes('[')
  )
    return false;
  const portMatch = /^(.*?)(?::(\d+))?$/u.exec(authority);
  if (!portMatch) return false;
  const hostname = portMatch[1]!;
  const port = portMatch[2];
  if (
    port &&
    !(
      (scheme === 'https' && port === '443') ||
      (scheme === 'http' && port === '80')
    )
  )
    return false;
  const path = value.slice(match[0].length);
  return isNotionAssetLocation(hostname, path);
}

function replacement(value: string): string | undefined {
  if (/%(?![0-9a-f]{2})/iu.test(value)) return undefined;
  try {
    const url = new URL(classificationValue(value));
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      !isNotionAssetHost(url) ||
      !hasSignatureParameter(url)
    )
      return undefined;
    return stableReferenceUrl(url.href, 'notion');
  } catch {
    return undefined;
  }
}

interface UrlSpan {
  start: number;
  end: number;
}

// UrlSpan に構文分類を添えたもの。境界計算そのものは構文を問わないため UrlSpan のまま
// 行い、置換候補として上位へ返す段階でだけ context を付与する。
interface ContextualSpan extends UrlSpan {
  context: ReplacementContext;
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

// span は URL 1つだけを含み、周囲の本文を含まない。空白を含む候補は構文の切れ目を跨いでいる。
function urlSpan(
  markdown: string,
  start: number,
  end: number,
): UrlSpan | undefined {
  if (!/^https?:\/\/\S+$/iu.test(markdown.slice(start, end))) return undefined;
  return { start, end };
}

// 空白で終わっただけの destination はリンクだと確定できない。CommonMark では title を挟んで
// 閉じ `)` が来て初めてリンクで、`)` が無ければ行全体が本文テキストになる。閉じ `)` を確認せずに
// 採用すると、`[a](URL（保留）` のように URL へ密着した本文を span に含めて失う。
function closesOnSameLine(markdown: string, from: number): boolean {
  for (let index = from; index < markdown.length; index += 1) {
    const character = markdown[index]!;
    if (character === '\n') return false;
    if (character === ')') return true;
  }
  return false;
}

// CommonMark の link destination。深さ0の `)` で終端するか、閉じ `)` が同じ行に続く空白で終端する。
function linkDestinationEnd(
  markdown: string,
  from: number,
): number | undefined {
  let depth = 0;
  for (let index = from; index < markdown.length; index += 1) {
    const character = markdown[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '\n') return undefined;
    if (isWhitespace(character))
      return closesOnSameLine(markdown, index) ? index : undefined;
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return undefined;
}

function closingDelimiter(
  markdown: string,
  from: number,
  closing: string,
): number | undefined {
  for (let index = from; index < markdown.length; index += 1) {
    const character = markdown[index]!;
    if (character === '\n') return undefined;
    if (character === closing) return index;
  }
  return undefined;
}

// HTML の属性値は改行を含んでもよい。開始タグの終端（`>`）を見失わないためだけに使う
// ので、値の中身は問わない。実際に置換対象として採用する span は urlSpan の `\S+` が
// 改行を含む値を弾くため、ここで改行を許しても署名 URL の抽出範囲は変わらない。
function closingQuoteAcrossLines(
  markdown: string,
  from: number,
  closing: string,
  limit: number,
): number | undefined {
  for (let index = from; index < limit; index += 1) {
    if (markdown[index] === closing) return index;
  }
  return undefined;
}

// HTML ブロック内の `<table>` 救済（htmlDestinationSpans）専用。link / image ノードの
// destination は resourceDestination token（destinationTokenSpans）を使うため、こちらは
// AST が確定していない生 HTML の中で `](` 記法を受け入れる場合にのみ使う。
function destinationSpan(
  markdown: string,
  from: number,
  limit: number,
): UrlSpan | undefined {
  if (markdown[from] === '<') {
    const close = closingDelimiter(markdown, from + 1, '>');
    if (close === undefined || close >= limit) return undefined;
    return urlSpan(markdown, from + 1, close);
  }
  const end = linkDestinationEnd(markdown, from);
  if (end === undefined || end >= limit) return undefined;
  return urlSpan(markdown, from, end);
}

// link / image ノードの直接の子孫にある link / image ノードの範囲。CommonMark はリンクの
// 入れ子を許さないが、リンクテキストに画像は置ける（`[![alt](inner)](outer)`）。内側の
// destination token を外側の destination と取り違えないために除外範囲として使う。
function descendantLinkOrImageRanges(node: MarkdownNode): UrlSpan[] {
  const ranges: UrlSpan[] = [];
  for (const child of node.children ?? []) {
    const childStart = child.position?.start.offset;
    const childEnd = child.position?.end.offset;
    if (
      (child.type === 'link' || child.type === 'image') &&
      childStart !== undefined &&
      childEnd !== undefined
    )
      ranges.push({ start: childStart, end: childEnd });
    ranges.push(...descendantLinkOrImageRanges(child));
  }
  return ranges;
}

// ノード範囲内にあり、かつ入れ子の link / image ノードに属さない destination token。
// 記号列を後方から推測する `lastIndexOf('](', ...)` と違い、parser が確定した位置だけを見る。
function ownDestinationToken(
  start: number,
  end: number,
  exclude: UrlSpan[],
): UrlSpan | undefined {
  return destinationTokenSpans.find(
    (span) =>
      span.start >= start &&
      span.end <= end &&
      !exclude.some(
        (range) => span.start >= range.start && span.end <= range.end,
      ),
  );
}

function linkNodeSpan(
  markdown: string,
  node: MarkdownNode,
): ContextualSpan | undefined {
  const start = node.position!.start.offset!;
  const end = node.position!.end.offset!;
  // autolink `<https://…>`。GFM の literal autolink（生の URL がそのままリンクになる形）は
  // 終端規則が本文の密着を判別できないため、`<` で始まるものだけを構文として認める。
  if (markdown[start] === '<') {
    if (markdown[end - 1] !== '>') return undefined;
    const span = urlSpan(markdown, start + 1, end - 1);
    return span ? { ...span, context: 'autolink' } : undefined;
  }
  const token = ownDestinationToken(
    start,
    end,
    descendantLinkOrImageRanges(node),
  );
  if (!token) return undefined;
  const context: ReplacementContext =
    node.type === 'image' ? 'markdown-image' : 'markdown-link';
  const span =
    markdown[token.start] === '<' && markdown[token.end - 1] === '>'
      ? urlSpan(markdown, token.start + 1, token.end - 1)
      : urlSpan(markdown, token.start, token.end);
  return span ? { ...span, context } : undefined;
}

function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; markdown[cursor] === '\\'; cursor -= 1)
    backslashes += 1;
  return backslashes % 2 === 1;
}

// HTML の開始タグかどうか。`<!--`（コメント）・`<!DOCTYPE`/`<![CDATA[`（`<!`）・`</tag>`
// （終了タグ）・`<?`（処理命令）はいずれもタグ名で始まらないため除外される。
function isStartTagOpening(markdown: string, index: number): boolean {
  const next = markdown[index + 1];
  return next !== undefined && /[A-Za-z]/u.test(next);
}

// 開始タグの終端（引用符内の `>` はタグを終端させない）。HTML の開始タグは属性の値が
// 複数行にまたがってもよいため、タグ自体の走査も引用符の対応探索も改行で打ち切らない
// （`closingQuoteAcrossLines`）。属性値そのものの抽出（attributeSpans）は同じ行で
// 閉じる制約を維持するため、値が複数行にまたがる属性は個別に読み飛ばされるだけで、
// 同じタグ内の他の属性（署名 URL を持つ `src` 等）まで巻き込んでタグ全体を諦めない。
function startTagEnd(
  markdown: string,
  tagStart: number,
  limit: number,
): number | undefined {
  let index = tagStart + 1;
  while (index < limit) {
    const character = markdown[index]!;
    if (character === '>') return index;
    if (character === '"' || character === "'") {
      const close = closingQuoteAcrossLines(
        markdown,
        index + 1,
        character,
        limit,
      );
      if (close === undefined) return undefined;
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return undefined;
}

// HTML の引用符付き属性値。開始タグの内側だけを走査するため、raw text 要素
// （script/style/textarea/title）の本文・コメント・CDATA・処理命令にある `="…"` を
// 属性値と誤認しない。開始タグの外側は一切見ない（fail-closed）。
function attributeSpans(
  markdown: string,
  start: number,
  end: number,
): ContextualSpan[] {
  const spans: ContextualSpan[] = [];
  let index = start;
  while (index < end) {
    if (markdown[index] !== '<' || !isStartTagOpening(markdown, index)) {
      index += 1;
      continue;
    }
    const tagEnd = startTagEnd(markdown, index, end);
    if (tagEnd === undefined) {
      index += 1;
      continue;
    }
    for (let cursor = index; cursor < tagEnd; cursor += 1) {
      const character = markdown[cursor]!;
      if (
        (character !== '"' && character !== "'") ||
        markdown[cursor - 1] !== '='
      )
        continue;
      const close = closingDelimiter(markdown, cursor + 1, character);
      if (close === undefined || close >= tagEnd) continue;
      const span = urlSpan(markdown, cursor + 1, close);
      if (span) spans.push({ ...span, context: 'html-attribute' });
      cursor = close;
    }
    index = tagEnd + 1;
  }
  return spans;
}

// `]` から後方へ括弧の対応を数え、未対応の未エスケープ `[`（`![` を含む）が同じ行にあるかを
// 見る。対応済みの `[note]` のような無関係な角括弧は数え尽くされて対象にならない。
function hasMatchingOpeningBracketOnLine(
  markdown: string,
  closeIndex: number,
  limit: number,
): boolean {
  let depth = 1;
  for (let cursor = closeIndex - 1; cursor >= limit; cursor -= 1) {
    const character = markdown[cursor]!;
    if (character === '\n') return false;
    if (isEscaped(markdown, cursor)) continue;
    if (character === ']') {
      depth += 1;
    } else if (character === '[') {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

// HTML ブロックの内側では Markdown のリンク構文は解釈されないが、Notion の `<table>` は
// 画像記法をそのまま含んで出力する。実データを止めないために受け入れるが、対応する開き括弧が
// 同じ行にあり destination が閉じている場合に限る。`foo](URL(note))` のように対応する開き
// 括弧を欠く記号列を受け入れると、密着した本文を span に含めて失うため。
function htmlDestinationSpans(
  markdown: string,
  start: number,
  end: number,
): ContextualSpan[] {
  const spans: ContextualSpan[] = [];
  for (let index = start; index + 1 < end; index += 1) {
    if (markdown[index] !== ']' || markdown[index + 1] !== '(') continue;
    if (isEscaped(markdown, index)) continue;
    if (!hasMatchingOpeningBracketOnLine(markdown, index, start)) continue;
    const span = destinationSpan(markdown, index + 2, end);
    if (!span) continue;
    spans.push({ ...span, context: 'html-rescue' });
    index = span.end;
  }
  return spans;
}

function nodeSpans(markdown: string, node: MarkdownNode): ContextualSpan[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  if (node.type === 'link' || node.type === 'image') {
    const span = linkNodeSpan(markdown, node);
    return span ? [span] : [];
  }
  if (node.type === 'html')
    return [
      ...attributeSpans(markdown, start, end),
      ...htmlDestinationSpans(markdown, start, end),
    ];
  return [];
}

// 構文で範囲が確定する URL の span。Markdown を parse して link / image / html ノードの
// 位置から取るので、`foo](URL)` のようにリンクとして成立しない記号列は span にならない。
// コードフェンス・inline code の内側にはこれらのノードが現れないため、そこの URL は
// すべて範囲未確定として停止する。stringify は行わないので WikiLink は壊れない。
function confirmedUrlSpans(markdown: string): ContextualSpan[] {
  const spans: ContextualSpan[] = [];
  const collect = (node: MarkdownNode): void => {
    spans.push(...nodeSpans(markdown, node));
    for (const child of node.children ?? []) collect(child);
  };
  // destinationTokenSpans は parse 呼び出しのたびにリセットする。単一スレッド・同期呼び出し
  // なので、parse 完了直後に読む限り前回呼び出し分と混ざらない。
  destinationTokenSpans = [];
  try {
    collect(markdownParser.parse(markdown) as MarkdownNode);
  } catch {
    return [];
  }
  return spans.sort((left, right) => left.start - right.start);
}

// 停止すべき URL かを判定するためだけの候補。置換には使わない。
function unboundedCandidate(markdown: string, start: number): string {
  let index = start;
  while (index < markdown.length && !isWhitespace(markdown[index]!)) index += 1;
  return markdown.slice(start, index);
}

function isSignedNotionAsset(value: string): boolean {
  return (
    rawKnownNotionAssetHost(value) && hasClassifiedSignatureParameter(value)
  );
}

// 呼び出しごとに新しい配列を返す（呼び出し間で同一インスタンスを共有すると、
// どこかで戻り値の配列へ push した場合に以降の全呼び出しへ波及するため）。
function emptyResult(markdown: string): SignedUrlReplacementResult {
  return {
    markdown,
    replacedCount: 0,
    boundaryUndeterminedCount: 0,
    unparseableSignedUrlCount: 0,
    replacements: [],
    unsafe: [],
  };
}

export function replaceRetainedSignedUrls(
  markdown: string,
): SignedUrlReplacementResult {
  // URL が無ければ span も停止対象も生じない。Data Source は property 文字列ごとに
  // 本関数を呼ぶため、そのたびに Markdown を parse しないよう先に打ち切る。
  if (!/https?:\/\//iu.test(markdown)) return emptyResult(markdown);
  const spans = confirmedUrlSpans(markdown);
  const output: string[] = [];
  let sourceStart = 0;
  const replacements: Replacement[] = [];
  const unsafe: UnsafeOccurrence[] = [];

  const replacedSpans: UrlSpan[] = [];
  const evaluatedStarts = new Set<number>();
  for (const span of spans) {
    // span は昇順だが重複しない保証はない（html ノードは属性値と destination を別々に集める）。
    // 重なりを許すと sourceStart が後退して出力に本文が二重に現れる。
    if (span.start < sourceStart) continue;
    const value = markdown.slice(span.start, span.end);
    const stableUrl = replacement(value);
    evaluatedStarts.add(span.start);
    if (stableUrl !== undefined) {
      output.push(markdown.slice(sourceStart, span.start), stableUrl);
      sourceStart = span.end;
      replacements.push({
        start: span.start,
        end: span.end,
        sourceHash: sha256(value),
        replacement: stableUrl,
        context: span.context,
      });
      replacedSpans.push(span);
    } else if (isSignedNotionAsset(value)) {
      unsafe.push({
        sourceHash: sha256(value),
        reason: 'unparseable',
        context: span.context,
      });
    }
  }

  const urlStart = /https?:\/\//giu;
  for (
    let match = urlStart.exec(markdown);
    match;
    match = urlStart.exec(markdown)
  ) {
    const start = match.index;
    // 置換した span の中身は出力から消えているので見る必要がない。置換しなかった span は
    // 本文として残るため、その内側に入れ子で現れる署名URLも判定する。
    if (
      evaluatedStarts.has(start) ||
      replacedSpans.some((span) => start >= span.start && start < span.end)
    )
      continue;
    const candidate = unboundedCandidate(markdown, start);
    if (replacement(candidate) !== undefined) {
      unsafe.push({
        sourceHash: sha256(candidate),
        reason: 'boundary-undetermined',
        context: 'bare-url',
      });
    } else if (isSignedNotionAsset(candidate)) {
      unsafe.push({
        sourceHash: sha256(candidate),
        reason: 'unparseable',
        context: 'bare-url',
      });
    }
    // 候補の末尾まで読み飛ばさない。`https://外部/a](https://file.notion.so/b?Signature=x`
    // のように候補の内側へ入れ子で現れる署名URLを、外側の判定だけで素通りさせないため。
  }

  const replacedCount = replacements.length;
  const boundaryUndeterminedCount = unsafe.filter(
    ({ reason }) => reason === 'boundary-undetermined',
  ).length;
  const unparseableSignedUrlCount = unsafe.filter(
    ({ reason }) => reason === 'unparseable',
  ).length;

  if (replacedCount === 0) {
    return {
      markdown,
      replacedCount,
      boundaryUndeterminedCount,
      unparseableSignedUrlCount,
      replacements,
      unsafe,
    };
  }
  output.push(markdown.slice(sourceStart));
  return {
    markdown: output.join(''),
    replacedCount,
    boundaryUndeterminedCount,
    unparseableSignedUrlCount,
    replacements,
    unsafe,
  };
}
