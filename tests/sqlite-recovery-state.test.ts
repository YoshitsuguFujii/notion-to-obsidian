import { describe, expect, it } from 'vitest';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

function seedRoot(store: SqliteStateStore): void {
  store.upsertRoot({
    rootPageId: 'root-id',
    localName: 'Root',
    status: 'complete',
  });
}

describe('SqliteStateStore recovery operations', () => {
  it('hash・missing・tombstoneを含むresource全状態を保存して一覧取得する', () => {
    using store = new SqliteStateStore(':memory:');
    seedRoot(store);
    store.upsertResource({
      notionId: 'page-id',
      objectType: 'page',
      rootId: 'root-id',
      title: 'Page',
      localPath: '.trash/2026-07-12/Page.md',
      expectedPath: 'Page.md',
      resolvedFilename: 'Page',
      lastEditedTime: '2026-07-12T00:00:00.000Z',
      contentHash: 'content',
      structureHash: 'structure',
      inTrash: true,
      status: 'tombstoned',
      missingCount: 2,
      tombstonedAt: '2026-07-12T01:00:00.000Z',
      trashReason: 'confirmed_not_found',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T01:00:00.000Z',
    });
    expect(store.listResources()).toEqual([store.getResource('page-id')]);
    expect(store.getResource('page-id')).toMatchObject({
      contentHash: 'content',
      structureHash: 'structure',
      missingCount: 2,
      status: 'tombstoned',
      trashReason: 'confirmed_not_found',
    });
  });

  it('finished_atが無いrunだけを返す', () => {
    using store = new SqliteStateStore(':memory:');
    store.beginRun({
      runId: 'unfinished',
      startedAt: '2026-07-12T00:00:00.000Z',
      mode: 'full',
      configHash: 'config',
      apiVersion: '2026-03-11',
      toolVersion: '0.1.0',
      transformVersion: '1',
    });
    expect(store.listUnfinishedRuns().map(({ runId }) => runId)).toEqual([
      'unfinished',
    ]);
  });

  it('runを完了し最新runとして取得する', () => {
    using store = new SqliteStateStore(':memory:');
    store.beginRun({
      runId: 'run-1',
      startedAt: '2026-07-12T00:00:00.000Z',
      mode: 'full',
      configHash: 'config',
      apiVersion: '2026-03-11',
      toolVersion: '0.1.0',
      transformVersion: '1',
    });
    store.finishRun({
      runId: 'run-1',
      finishedAt: '2026-07-12T01:00:00.000Z',
      success: true,
      partial: false,
      counts: {
        create: 1,
        update: 2,
        move: 0,
        trash: 0,
        unchanged: 3,
        error: 0,
      },
    });
    expect(store.getLatestRun()).toMatchObject({
      runId: 'run-1',
      finishedAt: '2026-07-12T01:00:00.000Z',
      success: true,
      counts: { create: 1, update: 2, unchanged: 3 },
    });
  });

  it('assetとwarningを保存して一覧取得する', () => {
    using store = new SqliteStateStore(':memory:');
    seedRoot(store);
    store.beginRun({
      runId: 'run-asset',
      startedAt: '2026-07-12T00:00:00.000Z',
      mode: 'full',
      configHash: 'config',
      apiVersion: '2026-03-11',
      toolVersion: '0.1.0',
      transformVersion: '1',
    });
    store.upsertResource({
      notionId: 'page-id',
      objectType: 'page',
      rootId: 'root-id',
      title: 'Page',
      localPath: 'Page.md',
      expectedPath: 'Page.md',
      resolvedFilename: 'Page',
      lastEditedTime: '2026-07-12T00:00:00.000Z',
      inTrash: false,
      status: 'active',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    });
    store.upsertAsset({
      stableKey: 'page-id:block-id',
      pageId: 'page-id',
      blockId: 'block-id',
      localPath: '_assets/page-id/file.png',
      originalName: 'file.png',
      mimeType: 'image/png',
      size: 10,
      etag: 'etag',
      lastSeenRunId: 'run-asset',
      fetchedAt: '2026-07-12T00:00:00.000Z',
    });
    store.insertWarning({
      runId: 'run-asset',
      resourceId: 'page-id',
      warningType: 'asset_failed',
      message: 'kept remote URL',
      createdAt: '2026-07-12T00:00:00.000Z',
    });
    expect(store.getAsset('page-id:block-id')).toMatchObject({
      etag: 'etag',
      size: 10,
    });
    expect(store.listAssets()).toHaveLength(1);
    expect(store.listWarnings('run-asset')).toEqual([
      expect.objectContaining({ warningType: 'asset_failed' }),
    ]);
  });
});
