import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpDownloader } from '../src/assets/http-downloader.js';

const temporaryDirectories: string[] = [];

async function temporaryDestination(): Promise<{
  directory: string;
  destination: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'notion-assets-'));
  temporaryDirectories.push(directory);
  return { directory, destination: join(directory, 'asset.bin') };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.useRealTimers();
});

describe('NodeHttpDownloader', () => {
  it('レスポンスを一時ファイルへ streaming し、完了後に最終パスへ配置する', async () => {
    const { directory, destination } = await temporaryDestination();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello '));
          controller.enqueue(new TextEncoder().encode('world'));
          controller.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/octet-stream',
          etag: 'etag-1',
          'last-modified': 'Sat, 11 Jul 2026 00:00:00 GMT',
        },
      },
    );
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const downloader = new NodeHttpDownloader({
      fetch: () => Promise.resolve(response),
      validateUrl: () => Promise.resolve(),
      temporaryId: () => 'fixed',
    });

    await expect(
      downloader.download({
        url: new URL('https://assets.example/file'),
        destination,
        maximumBytes: 1024,
      }),
    ).resolves.toEqual({
      size: 11,
      contentType: 'application/octet-stream',
      etag: 'etag-1',
      lastModified: 'Sat, 11 Jul 2026 00:00:00 GMT',
    });
    expect(await readFile(destination, 'utf8')).toBe('hello world');
    expect(await readdir(directory)).toEqual(['asset.bin']);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('Content-Length が上限を超える場合は保存を開始しない', async () => {
    const { directory, destination } = await temporaryDestination();
    const downloader = new NodeHttpDownloader({
      fetch: () =>
        Promise.resolve(
          new Response('oversized', { headers: { 'content-length': '100' } }),
        ),
      validateUrl: () => Promise.resolve(),
    });

    await expect(
      downloader.download({
        url: new URL('https://assets.example/file'),
        destination,
        maximumBytes: 10,
      }),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('許可されていない Content-Type は保存しない', async () => {
    const { directory, destination } = await temporaryDestination();
    const downloader = new NodeHttpDownloader({
      fetch: () =>
        Promise.resolve(
          new Response('content', {
            headers: { 'content-type': 'text/html' },
          }),
        ),
      validateUrl: () => Promise.resolve(),
    });

    await expect(
      downloader.download({
        url: new URL('https://assets.example/file'),
        destination,
        maximumBytes: 100,
        allowedContentTypes: ['image/png'],
      }),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('許可されていない保存先拡張子は通信前に拒否する', async () => {
    const { directory, destination } = await temporaryDestination();
    const fetch = vi.fn(() => Promise.resolve(new Response('content')));
    const downloader = new NodeHttpDownloader({
      fetch,
      validateUrl: () => Promise.resolve(),
    });

    await expect(
      downloader.download({
        url: new URL('https://assets.example/file'),
        destination,
        maximumBytes: 100,
        allowedExtensions: ['.png'],
      }),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('streaming 中に上限を超えた場合は最終・一時ファイルを残さない', async () => {
    const { directory, destination } = await temporaryDestination();
    const downloader = new NodeHttpDownloader({
      fetch: () => Promise.resolve(new Response('12345678901')),
      validateUrl: () => Promise.resolve(),
      temporaryId: () => 'fixed',
    });

    await expect(
      downloader.download({
        url: new URL('https://assets.example/file'),
        destination,
        maximumBytes: 10,
      }),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('timeout 時はリクエストを中断し、ファイルを残さない', async () => {
    vi.useFakeTimers();
    const { directory, destination } = await temporaryDestination();
    const downloader = new NodeHttpDownloader({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
      validateUrl: () => Promise.resolve(),
      timeoutMilliseconds: 100,
    });
    const download = downloader.download({
      url: new URL('https://assets.example/file'),
      destination,
      maximumBytes: 10,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(download).rejects.toMatchObject({ category: 'network' });
    expect(await readdir(directory)).toEqual([]);
  });
});
