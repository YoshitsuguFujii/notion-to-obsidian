import { describe, expect, it } from 'vitest';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

const root = {
  rootPageId: 'root-id',
  localName: 'Notes',
  lastSuccessfulCensus: '2026-07-11T00:00:00.000Z',
  status: 'complete' as const,
};

const resource = {
  notionId: 'page-id',
  objectType: 'page' as const,
  rootId: 'root-id',
  parentId: 'root-id',
  title: 'Page',
  expectedPath: 'Notes/Page.md',
  resolvedFilename: 'Page',
  lastEditedTime: '2026-07-11T00:00:00.000Z',
  inTrash: false,
  status: 'active' as const,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

describe('SqliteStateStore census state', () => {
  it('root と resource を安定 ID で upsert する', () => {
    using store = new SqliteStateStore(':memory:');

    store.transaction(() => {
      store.upsertRoot(root);
      store.upsertResource(resource);
      store.upsertResource({
        ...resource,
        title: 'Renamed',
        expectedPath: 'Notes/Renamed.md',
        resolvedFilename: 'Renamed',
        updatedAt: '2026-07-12T00:00:00.000Z',
      });
    });

    expect(store.getRoot('root-id')).toMatchObject(root);
    expect(store.getResource('page-id')).toMatchObject({
      notionId: 'page-id',
      title: 'Renamed',
      expectedPath: 'Notes/Renamed.md',
      resolvedFilename: 'Renamed',
      missingCount: 0,
    });
  });

  it('transaction 失敗時に root と resource の両方を保存しない', () => {
    using store = new SqliteStateStore(':memory:');

    expect(() =>
      store.transaction(() => {
        store.upsertRoot(root);
        store.upsertResource(resource);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    expect(store.getRoot('root-id')).toBeUndefined();
    expect(store.getResource('page-id')).toBeUndefined();
  });

  it('不在確認状態の更新で保存先や所属ルートを変更しない', () => {
    using store = new SqliteStateStore(':memory:');
    store.upsertRoot(root);
    store.upsertResource({
      ...resource,
      localPath: 'Notes/Page.md',
      contentHash: 'content-hash',
    });

    store.updateResourceMissingState('page-id', { missingCount: 1 });

    expect(store.getResource('page-id')).toMatchObject({
      rootId: 'root-id',
      localPath: 'Notes/Page.md',
      contentHash: 'content-hash',
      missingCount: 1,
      status: 'active',
    });
  });
});
