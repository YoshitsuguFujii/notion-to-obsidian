import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainError, InfraError } from '../errors.js';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressLookup = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ValidationOptions {
  lookup?: AddressLookup;
}

interface RedirectOptions extends ValidationOptions {
  fetch?: FetchLike;
  maximumRedirects?: number;
  signal?: AbortSignal;
  validateUrl?: (url: URL) => Promise<void>;
}

function parseIpv4(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split('.').map(Number);
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [first, second, third] = octets;
  return (
    first === undefined ||
    first < 1 ||
    first > 223 ||
    first === 10 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function normalizeIpv6(address: string): string {
  return address.toLowerCase().split('%')[0] ?? address.toLowerCase();
}

function parseIpv6(address: string): readonly number[] | undefined {
  let normalized = normalizeIpv6(address);
  if (isIP(normalized) !== 6) return undefined;

  const lastColon = normalized.lastIndexOf(':');
  const ipv4Suffix = normalized.slice(lastColon + 1);
  if (ipv4Suffix.includes('.')) {
    const octets = parseIpv4(ipv4Suffix);
    if (!octets) return undefined;
    const [first, second, third, fourth] = octets;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return undefined;
    }
    const high = (first << 8) | second;
    const low = (third << 8) | fourth;
    normalized = `${normalized.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (value: string): number[] | undefined => {
    if (value === '') return [];
    const groups = value.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
      return undefined;
    }
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseGroups(halves[0] ?? '');
  const right = parseGroups(halves[1] ?? '');
  if (!left || !right) return undefined;

  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const omittedGroupCount = 8 - left.length - right.length;
  if (omittedGroupCount < 1) return undefined;
  return [...left, ...Array<number>(omittedGroupCount).fill(0), ...right];
}

interface Ipv6Prefix {
  groups: readonly number[];
  length: number;
}

function matchesIpv6Prefix(
  groups: readonly number[],
  prefix: Ipv6Prefix,
): boolean {
  const completeGroups = Math.floor(prefix.length / 16);
  for (let index = 0; index < completeGroups; index += 1) {
    if (groups[index] !== prefix.groups[index]) return false;
  }
  const remainingBits = prefix.length % 16;
  if (remainingBits === 0) return true;
  const group = groups[completeGroups];
  const prefixGroup = prefix.groups[completeGroups];
  if (group === undefined || prefixGroup === undefined) return false;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (group & mask) === (prefixGroup & mask);
}

// 2001::/23 is non-global by default, but these more-specific IANA assignments are reachable.
const globallyReachableIetfProtocolAssignments: readonly Ipv6Prefix[] = [
  { groups: [0x2001, 0x0001, 0, 0, 0, 0, 0, 1], length: 128 },
  { groups: [0x2001, 0x0001, 0, 0, 0, 0, 0, 2], length: 128 },
  { groups: [0x2001, 0x0001, 0, 0, 0, 0, 0, 3], length: 128 },
  { groups: [0x2001, 0x0003], length: 32 },
  { groups: [0x2001, 0x0004, 0x0112], length: 48 },
  { groups: [0x2001, 0x0020], length: 28 },
  { groups: [0x2001, 0x0030], length: 28 },
];

const blockedSpecialPurposeIpv6Prefixes: readonly Ipv6Prefix[] = [
  { groups: [0x2001, 0], length: 23 },
  { groups: [0x2001, 0x0db8], length: 32 },
  { groups: [0x2002], length: 16 },
  { groups: [0x3fff, 0], length: 20 },
];

function isBlockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const [first, second] = groups;

  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const high = groups[6];
    const low = groups[7];
    if (high === undefined || low === undefined) return true;
    return isBlockedIpv4(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
    );
  }

  if (
    globallyReachableIetfProtocolAssignments.some((prefix) =>
      matchesIpv6Prefix(groups, prefix),
    )
  ) {
    return false;
  }

  return (
    first === undefined ||
    second === undefined ||
    first < 0x2000 ||
    first > 0x3fff ||
    blockedSpecialPurposeIpv6Prefixes.some((prefix) =>
      matchesIpv6Prefix(groups, prefix),
    )
  );
}

export function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizeIpv6(address);
  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}

const defaultLookup: AddressLookup = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function safetyError(message: string): DomainError {
  return new DomainError('safety', message);
}

export async function validateDownloadUrl(
  url: URL,
  options: ValidationOptions = {},
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw safetyError('Asset URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw safetyError('Asset URL must not contain credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw safetyError('Asset URL resolves to a local host');
  }
  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw safetyError('Asset URL resolves to a non-public address');
    }
    return;
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname);
  } catch (cause) {
    throw new InfraError('network', 'Asset host could not be resolved', {
      cause,
    });
  }
  if (addresses.length === 0) {
    throw new InfraError('network', 'Asset host did not resolve to an address');
  }
  if (addresses.some(({ address }) => isBlockedIpAddress(address))) {
    throw safetyError('Asset URL resolves to a non-public address');
  }
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export async function fetchWithValidatedRedirects(
  initialUrl: URL,
  options: RedirectOptions = {},
): Promise<Response> {
  const request = options.fetch ?? globalThis.fetch;
  const maximumRedirects = options.maximumRedirects ?? 5;
  let url = initialUrl;

  for (let redirects = 0; ; redirects += 1) {
    if (options.validateUrl) {
      await options.validateUrl(url);
    } else {
      await validateDownloadUrl(url, options);
    }
    const requestInit: RequestInit = {
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const response = await request(url, requestInit);
    if (!redirectStatuses.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= maximumRedirects) {
      await response.body?.cancel();
      throw safetyError('Asset URL exceeded the redirect limit');
    }
    await response.body?.cancel();
    url = new URL(location, url);
  }
}
