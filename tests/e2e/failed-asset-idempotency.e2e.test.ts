import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DownloadRequest,
  DownloadResult,
} from '../../src/assets/http-downloader.js';
import { createSyncHarness, ROOT_ID, rootPage } from './sync-harness.js';

const BLOCK_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_BLOCK_ID = '88888888-8888-4888-8888-888888888888';

function pageWithAsset(
  url: string,
  lastEditedTime = '2026-07-20T00:00:00.000Z',
) {
  return rootPage({
    lastEditedTime,
    markdown: `![Photo](${url})`,
    blocks: [
      {
        id: BLOCK_ID,
        type: 'image',
        image: { type: 'file', file: { url }, caption: [] },
      },
    ],
  });
}

function pageWithTwoAssets(
  firstUrl: string,
  secondUrl: string,
  lastEditedTime = '2026-07-20T00:00:00.000Z',
) {
  return rootPage({
    lastEditedTime,
    markdown: `![First](${firstUrl})\n\n![Second](${secondUrl})`,
    blocks: [
      {
        id: BLOCK_ID,
        type: 'image',
        image: { type: 'file', file: { url: firstUrl }, caption: [] },
      },
      {
        id: SECOND_BLOCK_ID,
        type: 'image',
        image: { type: 'file', file: { url: secondUrl }, caption: [] },
      },
    ],
  });
}

function successfulDownload(request: DownloadRequest): Promise<DownloadResult> {
  const content = 'asset-content';
  return mkdir(dirname(request.destination), { recursive: true })
    .then(() => writeFile(request.destination, content))
    .then(() => ({
      size: Buffer.byteLength(content),
      contentHash: createHash('sha256').update(content).digest('hex'),
      contentType: 'image/png',
    }));
}

describe('取得できないNotionアセットを含むページ', () => {
  it('署名queryが変わっても2回目は本文とmtimeを変更しない', async () => {
    const firstUrl =
      'https://files.example/photo.png?X-Amz-Signature=first#temporary';
    const secondUrl =
      'https://files.example/photo.png?X-Amz-Signature=second#rotated';
    const requestedUrls: string[] = [];
    const app = await createSyncHarness([pageWithAsset(firstUrl)], {
      downloadAsset: (request) => {
        requestedUrls.push(request.url.href);
        return Promise.reject(new Error('network unavailable'));
      },
    });
    try {
      await app.sync();
      const target = join(app.managedRoot, 'Notes.md');
      const fixedTime = new Date('2020-01-02T03:04:05.000Z');
      await utimes(target, fixedTime, fixedTime);
      const firstContent = await readFile(target, 'utf8');
      const firstStat = await stat(target);

      app.setNow('2026-07-20T02:00:00.000Z');
      app.setPages([pageWithAsset(secondUrl)]);
      const second = await app.sync();

      expect(second.actions).toContainEqual(
        expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
      );
      expect(await readFile(target, 'utf8')).toBe(firstContent);
      expect((await stat(target)).mtimeMs).toBe(firstStat.mtimeMs);
      expect(firstContent).toContain('https://files.example/photo.png');
      expect(firstContent).not.toContain('X-Amz-Signature');
      expect(firstContent).not.toContain('#temporary');
      expect(requestedUrls).toEqual([firstUrl]);
      expect(app.store.listAssets()).toEqual([]);
      const persistedState = JSON.stringify({
        resources: app.store.listResources(),
        assets: app.store.listAssets(),
        warnings: app.store.listWarnings(),
      });
      expect(persistedState).not.toContain('X-Amz-Signature');
      expect(persistedState).not.toContain('first');
    } finally {
      await app.close();
    }
  });

  it('未検証cacheは通常同期で再採用せずfull成功後にlocal参照へ復帰する', async () => {
    const url = 'https://files.example/photo.png?signature=first';
    let failDownload = false;
    const requestedUrls: string[] = [];
    const app = await createSyncHarness([pageWithAsset(url)], {
      downloadAsset: (request) => {
        requestedUrls.push(request.url.href);
        return failDownload
          ? Promise.reject(new Error('network unavailable'))
          : successfulDownload(request);
      },
    });
    try {
      await app.sync();
      const stableKey = `${ROOT_ID}:${BLOCK_ID}`;
      const usable = app.store.getAsset(stableKey)!;
      app.store.upsertAsset({
        ...usable,
        contentHash: '0'.repeat(64),
        cacheStatus: 'usable',
      });
      failDownload = true;
      app.setPages([
        pageWithAsset(
          'https://files.example/photo.png?signature=second',
          '2026-07-20T01:00:00.000Z',
        ),
      ]);
      await app.sync();
      expect(app.store.getAsset(stableKey)?.cacheStatus).toBe('unverified');

      const target = join(app.managedRoot, 'Notes.md');
      const fixedTime = new Date('2020-01-02T03:04:05.000Z');
      await utimes(target, fixedTime, fixedTime);
      const failedContent = await readFile(target, 'utf8');
      const failedMtime = (await stat(target)).mtimeMs;
      const requestsAfterFailure = requestedUrls.length;

      app.setNow('2026-07-20T03:00:00.000Z');
      app.setPages([
        pageWithAsset(
          'https://files.example/photo.png?signature=third',
          '2026-07-20T01:00:00.000Z',
        ),
      ]);
      const dryRun = await app.sync({ dryRun: true });
      expect(dryRun.actions).toContainEqual(
        expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
      );
      expect(app.store.getAsset(stableKey)?.cacheStatus).toBe('unverified');
      expect(await readFile(target, 'utf8')).toBe(failedContent);
      expect((await stat(target)).mtimeMs).toBe(failedMtime);
      expect(requestedUrls).toHaveLength(requestsAfterFailure);

      const unchanged = await app.sync();
      expect(unchanged.actions).toContainEqual(
        expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
      );
      expect(requestedUrls).toHaveLength(requestsAfterFailure);

      failDownload = false;
      await app.sync({ full: true });
      expect(app.store.getAsset(stableKey)?.cacheStatus).toBe('usable');
      const recoveredContent = await readFile(target, 'utf8');
      expect(recoveredContent).toContain(`_assets/${ROOT_ID}/${BLOCK_ID}`);

      app.setNow('2026-07-20T04:00:00.000Z');
      const stable = await app.sync();
      expect(stable.actions).toContainEqual(
        expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
      );
    } finally {
      await app.close();
    }
  });

  it('利用可能なcacheと未検証cacheが混在しても次回同期は収束する', async () => {
    const firstUrl = 'https://files.example/first.png?signature=first';
    const secondUrl = 'https://files.example/second.png?signature=first';
    let failedUrl: string | undefined;
    const app = await createSyncHarness(
      [pageWithTwoAssets(firstUrl, secondUrl)],
      {
        downloadAsset: (request) =>
          request.url.href === failedUrl
            ? Promise.reject(new Error('network unavailable'))
            : successfulDownload(request),
      },
    );
    try {
      await app.sync();
      const firstStableKey = `${ROOT_ID}:${BLOCK_ID}`;
      const secondStableKey = `${ROOT_ID}:${SECOND_BLOCK_ID}`;
      const secondAsset = app.store.getAsset(secondStableKey)!;
      app.store.upsertAsset({
        ...secondAsset,
        contentHash: '0'.repeat(64),
        cacheStatus: 'usable',
      });

      const rotatedFirst = 'https://files.example/first.png?signature=second';
      const rotatedSecond = 'https://files.example/second.png?signature=second';
      failedUrl = rotatedSecond;
      app.setPages([
        pageWithTwoAssets(
          rotatedFirst,
          rotatedSecond,
          '2026-07-20T01:00:00.000Z',
        ),
      ]);
      await app.sync();

      expect(app.store.getAsset(firstStableKey)?.cacheStatus).toBe('usable');
      expect(app.store.getAsset(secondStableKey)?.cacheStatus).toBe(
        'unverified',
      );
      const target = join(app.managedRoot, 'Notes.md');
      const fixedTime = new Date('2020-01-02T03:04:05.000Z');
      await utimes(target, fixedTime, fixedTime);
      const settledContent = await readFile(target, 'utf8');

      app.setNow('2026-07-20T03:00:00.000Z');
      app.setPages([
        pageWithTwoAssets(
          'https://files.example/first.png?signature=third',
          'https://files.example/second.png?signature=third',
          '2026-07-20T01:00:00.000Z',
        ),
      ]);
      const settled = await app.sync();

      expect(settled.actions).toContainEqual(
        expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
      );
      expect(await readFile(target, 'utf8')).toBe(settledContent);
      expect((await stat(target)).mtimeMs).toBe(fixedTime.getTime());
      expect(settledContent).toContain(`_assets/${ROOT_ID}/${BLOCK_ID}`);
      expect(settledContent).toContain('https://files.example/second.png');
      expect(settledContent).not.toContain('signature=');
    } finally {
      await app.close();
    }
  });
});
