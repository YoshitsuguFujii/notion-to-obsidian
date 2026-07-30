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

function isTerminatingCharacter(character: string): boolean {
  return (
    character.charCodeAt(0) > 0x7f ||
    /\s/u.test(character) ||
    /[<>"'`{[}\]\\^|]/u.test(character)
  );
}

function candidateEnd(
  markdown: string,
  start: number,
): {
  end: number;
  boundary: 'terminal' | 'closing-parenthesis' | 'eof';
} {
  let parentheses = 0;
  let index = start;
  while (index < markdown.length) {
    const character = markdown[index]!;
    if (isTerminatingCharacter(character))
      return { end: index, boundary: 'terminal' };
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0)
        return { end: index, boundary: 'closing-parenthesis' };
      parentheses -= 1;
    }
    index += 1;
  }
  return { end: index, boundary: 'eof' };
}

function withoutTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/u, '');
}

function hasAmbiguousAsciiTail(value: string): boolean {
  const schemeEnd = value.indexOf('://') + '://'.length;
  const nestedStart = value.slice(schemeEnd).search(/https?:\/\//iu);
  if (nestedStart >= 0) return true;
  const normalized = classificationValue(value);
  const queryStart = normalized.indexOf('?');
  if (queryStart < 0) return false;
  const tail = normalized.slice(queryStart + 1);
  return tail.split('&').some((parameter) => {
    const separator = parameter.indexOf('=');
    if (separator <= 0) return true;
    return /[,;]/u.test(parameter.slice(separator + 1));
  });
}

export function replaceRetainedSignedUrls(
  markdown: string,
): SignedUrlReplacementResult {
  const urlStart = /https?:\/\//giu;
  const output: string[] = [];
  let sourceStart = 0;
  let replacedCount = 0;
  let boundaryUndeterminedCount = 0;
  let unparseableSignedUrlCount = 0;
  for (
    let match = urlStart.exec(markdown);
    match;
    match = urlStart.exec(markdown)
  ) {
    const start = match.index;
    const scanned = candidateEnd(markdown, start);
    const scannedValue = markdown.slice(start, scanned.end);
    const candidate = withoutTrailingPunctuation(scannedValue);
    const end = start + candidate.length;
    const hasProof = scanned.boundary !== 'eof';
    const stableUrl = replacement(candidate);
    if (
      stableUrl !== undefined &&
      hasProof &&
      !hasAmbiguousAsciiTail(candidate)
    ) {
      output.push(markdown.slice(sourceStart, start), stableUrl);
      sourceStart = end;
      replacedCount += 1;
    } else if (stableUrl !== undefined) {
      boundaryUndeterminedCount += 1;
    } else if (
      rawKnownNotionAssetHost(candidate) &&
      hasClassifiedSignatureParameter(candidate)
    ) {
      unparseableSignedUrlCount += 1;
    }
    urlStart.lastIndex = Math.max(scanned.end, start + match[0].length);
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
