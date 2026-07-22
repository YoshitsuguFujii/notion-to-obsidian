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

function isDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isRegionalS3Host(hostname: string): boolean {
  return /^s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(hostname);
}

function isNotionAssetHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    isDomain(hostname, 'notion.so') ||
    isDomain(hostname, 'notion-static.com')
  )
    return true;
  if (
    hostname === 'prod-files-secure.s3.amazonaws.com' ||
    /^prod-files-secure\.s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(hostname)
  )
    return true;
  if (hostname !== 's3.amazonaws.com' && !isRegionalS3Host(hostname))
    return false;
  return url.pathname.split('/')[1] === 'secure.notion-static.com';
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

function candidateEnd(markdown: string, start: number): number {
  let parentheses = 0;
  let index = start;
  while (index < markdown.length) {
    const character = markdown[index]!;
    if (/\s/u.test(character) || /[<>"'`]/u.test(character)) break;
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0) break;
      parentheses -= 1;
    }
    index += 1;
  }
  return index;
}

function withoutTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/u, '');
}

export function replaceRetainedSignedUrls(markdown: string): {
  markdown: string;
  replacedCount: number;
} {
  const urlStart = /https?:\/\//giu;
  const output: string[] = [];
  let sourceStart = 0;
  let replacedCount = 0;
  for (
    let match = urlStart.exec(markdown);
    match;
    match = urlStart.exec(markdown)
  ) {
    const start = match.index;
    const scannedEnd = candidateEnd(markdown, start);
    const scanned = markdown.slice(start, scannedEnd);
    const candidate = withoutTrailingPunctuation(scanned);
    const end = start + candidate.length;
    const stableUrl = replacement(candidate);
    if (stableUrl !== undefined) {
      output.push(markdown.slice(sourceStart, start), stableUrl);
      sourceStart = end;
      replacedCount += 1;
    }
    urlStart.lastIndex = Math.max(scannedEnd, start + match[0].length);
  }
  if (replacedCount === 0) return { markdown, replacedCount };
  output.push(markdown.slice(sourceStart));
  return { markdown: output.join(''), replacedCount };
}
