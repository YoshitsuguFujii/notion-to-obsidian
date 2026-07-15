import { describe, expect, it, vi } from 'vitest';
import {
  fetchWithValidatedRedirects,
  isBlockedIpAddress,
  validateDownloadUrl,
} from '../src/assets/security.js';

describe('asset download URL safety', () => {
  it.each([
    '0.0.0.0',
    '0.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '169.254.169.254',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    'ff00::1',
    '2001:db8::1',
    '2001::1',
    '2002::1',
    'not-an-ip-address',
  ])('公開ネットワークではないアドレス %s を拒否する', (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('グローバルユニキャストアドレス %s を許可する', (address) => {
    expect(isBlockedIpAddress(address)).toBe(false);
  });

  it('0.0.0.0 宛ての URL を SSRF 検証で拒否する', async () => {
    await expect(
      validateDownloadUrl(new URL('http://0.0.0.0/internal')),
    ).rejects.toMatchObject({
      name: 'DomainError',
      category: 'safety',
    });
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/file'])(
    'HTTP(S) 以外の URL %s を拒否する',
    async (url) => {
      await expect(validateDownloadUrl(new URL(url))).rejects.toMatchObject({
        name: 'DomainError',
        category: 'safety',
      });
    },
  );

  it('localhost を拒否する', async () => {
    await expect(
      validateDownloadUrl(new URL('https://localhost/file')),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('DNS が private address を返すホストを拒否する', async () => {
    await expect(
      validateDownloadUrl(new URL('https://assets.example/file'), {
        lookup: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('DNS の全解決結果が公開アドレスなら許可する', async () => {
    await expect(
      validateDownloadUrl(new URL('https://assets.example/file'), {
        lookup: () =>
          Promise.resolve([
            { address: '8.8.8.8', family: 4 },
            { address: '2606:4700:4700::1111', family: 6 },
          ]),
      }),
    ).resolves.toBeUndefined();
  });

  it('リダイレクト先も検証し、private address にはアクセスしない', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/secret' },
        }),
      ),
    );

    await expect(
      fetchWithValidatedRedirects(new URL('https://assets.example/file'), {
        fetch,
        lookup: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('リダイレクト回数の上限を超えたら停止する', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: '/next' },
        }),
      ),
    );

    await expect(
      fetchWithValidatedRedirects(new URL('https://assets.example/file'), {
        fetch,
        lookup: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
        maximumRedirects: 2,
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
