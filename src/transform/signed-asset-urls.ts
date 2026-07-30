import { stableReferenceUrl } from './stable-url.js';

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

function classificationValue(value: string): string {
  const queryStart = value.indexOf('?');
  if (queryStart < 0) return value;
  const fragmentStart = value.indexOf('#', queryStart);
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  return `${value.slice(0, queryStart + 1)}${value
    .slice(queryStart + 1, queryEnd)
    .replace(/&amp;/giu, '&')}${value.slice(queryEnd)}`;
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

// CommonMark の link destination。空白または深さ0の `)` で終端し、終端しなければ確定できない。
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
    if (isWhitespace(character)) return index;
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

function destinationSpan(markdown: string, from: number): UrlSpan | undefined {
  if (markdown[from] === '<') {
    const end = closingDelimiter(markdown, from + 1, '>');
    return end === undefined ? undefined : urlSpan(markdown, from + 1, end);
  }
  const end = linkDestinationEnd(markdown, from);
  return end === undefined ? undefined : urlSpan(markdown, from, end);
}

function spanAt(markdown: string, index: number): UrlSpan | undefined {
  const character = markdown[index]!;
  if (character === ']' && markdown[index + 1] === '(')
    return destinationSpan(markdown, index + 2);
  if (character === '<') {
    const end = closingDelimiter(markdown, index + 1, '>');
    return end === undefined ? undefined : urlSpan(markdown, index + 1, end);
  }
  if ((character === '"' || character === "'") && markdown[index - 1] === '=') {
    const end = closingDelimiter(markdown, index + 1, character);
    return end === undefined ? undefined : urlSpan(markdown, index + 1, end);
  }
  return undefined;
}

// 構文で範囲が確定する URL の span。ここに含まれない URL は本文との境界を確定できない。
function confirmedUrlSpans(markdown: string): UrlSpan[] {
  if (/^https?:\/\/\S+$/iu.test(markdown))
    return [{ start: 0, end: markdown.length }];
  const spans: UrlSpan[] = [];
  let index = 0;
  while (index < markdown.length) {
    const span = spanAt(markdown, index);
    if (span) {
      spans.push(span);
      index = span.end;
      continue;
    }
    index += 1;
  }
  return spans;
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

export function replaceRetainedSignedUrls(
  markdown: string,
): SignedUrlReplacementResult {
  const spans = confirmedUrlSpans(markdown);
  const output: string[] = [];
  let sourceStart = 0;
  let replacedCount = 0;
  let boundaryUndeterminedCount = 0;
  let unparseableSignedUrlCount = 0;

  for (const span of spans) {
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
