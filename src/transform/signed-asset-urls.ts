import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { stableReferenceUrl } from './stable-url.js';

// parse だけを行い stringify はしない。AGENTS.md が禁じるのは round-trip による
// WikiLink 等の破壊であり、位置情報の取得だけなら本文へ影響しない。
const markdownParser = unified().use(remarkParse).use(remarkGfm);

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

// link / image ノードの destination。ノードの範囲は parser が確定しているので、
// その内側で `](` を探すのは記号列の推測ではなく確定した構文の内部を見ていることになる。
// `](` の直後から始まる destination。`limit` は属する構文の終端で、これを越える候補は採らない。
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

function linkNodeSpan(
  markdown: string,
  start: number,
  end: number,
): UrlSpan | undefined {
  // autolink `<https://…>`。GFM の literal autolink（生の URL がそのままリンクになる形）は
  // 終端規則が本文の密着を判別できないため、`<` で始まるものだけを構文として認める。
  if (markdown[start] === '<') {
    if (markdown[end - 1] !== '>') return undefined;
    return urlSpan(markdown, start + 1, end - 1);
  }
  const marker = markdown.lastIndexOf('](', end);
  if (marker < start) return undefined;
  return destinationSpan(markdown, marker + 2, end);
}

// HTML の引用符付き属性値。HTML ノードの内側だけを見るので、本文中の `="` とは混同しない。
function attributeSpans(
  markdown: string,
  start: number,
  end: number,
): UrlSpan[] {
  const spans: UrlSpan[] = [];
  for (let index = start; index < end; index += 1) {
    const character = markdown[index]!;
    if ((character !== '"' && character !== "'") || markdown[index - 1] !== '=')
      continue;
    const close = closingDelimiter(markdown, index + 1, character);
    if (close === undefined || close >= end) continue;
    const span = urlSpan(markdown, index + 1, close);
    if (span) spans.push(span);
    index = close;
  }
  return spans;
}

function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; markdown[cursor] === '\\'; cursor -= 1)
    backslashes += 1;
  return backslashes % 2 === 1;
}

function hasOpeningBracketOnLine(
  markdown: string,
  closeIndex: number,
  limit: number,
): boolean {
  for (let cursor = closeIndex - 1; cursor >= limit; cursor -= 1) {
    const character = markdown[cursor]!;
    if (character === '\n') return false;
    if (character === '[' && !isEscaped(markdown, cursor)) return true;
  }
  return false;
}

// HTML ブロックの内側では Markdown のリンク構文は解釈されないが、Notion の `<table>` は
// 画像記法をそのまま含んで出力する。実データを止めないために受け入れるが、対応する開き括弧が
// 同じ行にあり destination が閉じている場合に限る。`foo](URL(note))` のように開き括弧を
// 欠く記号列を受け入れると、密着した本文を span に含めて失うため。
function htmlDestinationSpans(
  markdown: string,
  start: number,
  end: number,
): UrlSpan[] {
  const spans: UrlSpan[] = [];
  for (let index = start; index + 1 < end; index += 1) {
    if (markdown[index] !== ']' || markdown[index + 1] !== '(') continue;
    if (isEscaped(markdown, index)) continue;
    if (!hasOpeningBracketOnLine(markdown, index, start)) continue;
    const span = destinationSpan(markdown, index + 2, end);
    if (!span) continue;
    spans.push(span);
    index = span.end;
  }
  return spans;
}

function nodeSpans(markdown: string, node: MarkdownNode): UrlSpan[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  if (node.type === 'link' || node.type === 'image') {
    const span = linkNodeSpan(markdown, start, end);
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
function confirmedUrlSpans(markdown: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  const collect = (node: MarkdownNode): void => {
    spans.push(...nodeSpans(markdown, node));
    for (const child of node.children ?? []) collect(child);
  };
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

const emptyResult = {
  replacedCount: 0,
  boundaryUndeterminedCount: 0,
  unparseableSignedUrlCount: 0,
};

export function replaceRetainedSignedUrls(
  markdown: string,
): SignedUrlReplacementResult {
  // URL が無ければ span も停止対象も生じない。Data Source は property 文字列ごとに
  // 本関数を呼ぶため、そのたびに Markdown を parse しないよう先に打ち切る。
  if (!/https?:\/\//iu.test(markdown)) return { markdown, ...emptyResult };
  const spans = confirmedUrlSpans(markdown);
  const output: string[] = [];
  let sourceStart = 0;
  let replacedCount = 0;
  let boundaryUndeterminedCount = 0;
  let unparseableSignedUrlCount = 0;

  for (const span of spans) {
    // span は昇順だが重複しない保証はない（html ノードは属性値と destination を別々に集める）。
    // 重なりを許すと sourceStart が後退して出力に本文が二重に現れる。
    if (span.start < sourceStart) continue;
    const value = markdown.slice(span.start, span.end);
    const stableUrl = replacement(value);
    if (stableUrl !== undefined) {
      output.push(markdown.slice(sourceStart, span.start), stableUrl);
      sourceStart = span.end;
      replacedCount += 1;
    } else if (isSignedNotionAsset(value)) {
      unparseableSignedUrlCount += 1;
    }
  }

  const urlStart = /https?:\/\//giu;
  for (
    let match = urlStart.exec(markdown);
    match;
    match = urlStart.exec(markdown)
  ) {
    const start = match.index;
    if (spans.some((span) => start >= span.start && start < span.end)) continue;
    const candidate = unboundedCandidate(markdown, start);
    if (replacement(candidate) !== undefined) {
      boundaryUndeterminedCount += 1;
    } else if (isSignedNotionAsset(candidate)) {
      unparseableSignedUrlCount += 1;
    }
    urlStart.lastIndex = start + candidate.length;
  }

  if (replacedCount === 0) {
    return {
      markdown,
      replacedCount,
      boundaryUndeterminedCount,
      unparseableSignedUrlCount,
    };
  }
  output.push(markdown.slice(sourceStart));
  return {
    markdown: output.join(''),
    replacedCount,
    boundaryUndeterminedCount,
    unparseableSignedUrlCount,
  };
}
