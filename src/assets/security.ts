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
  if (!octets) return false;
  const [first, second, third, fourth] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 169 && second === 254) ||
    (first === 255 && second === 255 && third === 255 && fourth === 255)
  );
}

function normalizeIpv6(address: string): string {
  return address.toLowerCase().split('%')[0] ?? address.toLowerCase();
}

function mappedIpv4Address(address: string): string | undefined {
  if (!address.startsWith('::ffff:')) return undefined;
  const suffix = address.slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(':');
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0] ?? '', 16);
  const low = Number.parseInt(groups[1] ?? '', 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isBlockedIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const normalized = normalizeIpv6(address);
  if (normalized === '::' || normalized === '::1') return true;
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  const firstGroup = Number.parseInt(normalized.split(':')[0] ?? '', 16);
  return (
    (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) ||
    (firstGroup >= 0xfe80 && firstGroup <= 0xfebf)
  );
}

export function isBlockedIpAddress(address: string): boolean {
  return isBlockedIpv4(address) || isBlockedIpv6(address);
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
