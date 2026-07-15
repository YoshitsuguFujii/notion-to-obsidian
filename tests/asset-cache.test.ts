import { describe, expect, it } from 'vitest';
import { shouldRedownload } from '../src/assets/cache.js';

describe('shouldRedownload', () => {
  const previous = {
    url: 'https://files.example/photo.png?signature=old',
    etag: 'etag-1',
    lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT',
    contentLength: 1024,
    contentHash: 'sha256-content',
    blockLastEditedTime: '2026-01-01T00:00:00.000Z',
  };

  it('利用可能なmetadataが同じなら署名queryが変わっても再取得しない', () => {
    expect(
      shouldRedownload(previous, {
        ...previous,
        url: 'https://files.example/photo.png?signature=new',
      }),
    ).toBe(false);
  });

  it.each([
    ['etag', 'etag-2'],
    ['lastModified', 'Tue, 02 Jan 2026 00:00:00 GMT'],
    ['contentLength', 2048],
    ['contentHash', 'sha256-changed'],
    ['blockLastEditedTime', '2026-01-02T00:00:00.000Z'],
  ] as const)('%sが変われば再取得する', (key, value) => {
    expect(shouldRedownload(previous, { ...previous, [key]: value })).toBe(
      true,
    );
  });

  it('比較可能なmetadataが無ければ再取得する', () => {
    expect(
      shouldRedownload(
        { url: 'https://files.example/one?signature=old' },
        { url: 'https://files.example/one?signature=new' },
      ),
    ).toBe(true);
  });

  it('前回記録が無ければ再取得する', () => {
    expect(shouldRedownload(undefined, { etag: 'etag-1' })).toBe(true);
  });
});
