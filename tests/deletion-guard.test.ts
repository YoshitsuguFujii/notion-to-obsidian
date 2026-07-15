import { describe, expect, it } from 'vitest';
import type { RootCensus } from '../src/notion/census.js';
import type { StoredResource } from '../src/storage/state-store.js';
import {
  assertTrashWithinLimits,
  planMissingResources,
} from '../src/sync/deletion-guard.js';

const census = (overrides: Partial<RootCensus> = {}): RootCensus => ({
  rootId: 'root-id',
  status: 'complete',
  deletionAllowed: true,
  resources: [],
  warnings: [],
  ...overrides,
});

const resource = (overrides: Partial<StoredResource> = {}): StoredResource => ({
  notionId: 'page-id',
  objectType: 'page',
  rootId: 'root-id',
  title: 'Page',
  localPath: 'Root/Page.md',
  expectedPath: 'Root/Page.md',
  resolvedFilename: 'Page',
  lastEditedTime: '2026-07-12T00:00:00.000Z',
  inTrash: false,
  status: 'active',
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
  missingCount: 0,
  ...overrides,
});

describe('planMissingResources', () => {
  it.each([
    [
      'partial census',
      { root: census({ status: 'partial', deletionAllowed: false }) },
    ],
    [
      'root failure',
      {
        root: census({
          status: 'partial',
          deletionAllowed: false,
          warnings: [
            {
              type: 'root_unavailable',
              resourceId: 'root-id',
              message: 'failed',
            },
          ],
        }),
      },
    ],
    [
      'pagination failure',
      {
        root: census({
          status: 'partial',
          deletionAllowed: false,
          warnings: [
            {
              type: 'child_list_incomplete',
              resourceId: 'root-id',
              message: 'failed',
            },
          ],
        }),
      },
    ],
    ['page mode', { mode: 'page' as const }],
    ['permission error', { blockingFailure: 'permission' as const }],
    ['rate limit', { blockingFailure: 'rate_limited' as const }],
    ['server error', { blockingFailure: 'server' as const }],
    ['Search incomplete', { blockingFailure: 'search_incomplete' as const }],
  ])('%s では missing を進めず TRASH を生成しない', (_label, override) => {
    expect(
      planMissingResources({
        root: census(),
        existing: [resource()],
        mode: 'full',
        dryRun: false,
        ...override,
      }),
    ).toEqual({ updates: [], trash: [] });
  });

  it('dry-runでもgrace runs到達時のmissing更新とTRASHを予測する', () => {
    expect(
      planMissingResources({
        root: census(),
        existing: [resource({ missingCount: 1 })],
        mode: 'full',
        dryRun: true,
      }),
    ).toEqual({
      updates: [{ notionId: 'page-id', missingCount: 2 }],
      trash: [{ notionId: 'page-id', reason: 'confirmed_not_found' }],
    });
  });

  it('1回目の missing は count の更新だけを計画する', () => {
    expect(
      planMissingResources({
        root: census(),
        existing: [resource()],
        mode: 'full',
        dryRun: false,
      }),
    ).toEqual({
      updates: [{ notionId: 'page-id', missingCount: 1 }],
      trash: [],
    });
  });

  it('grace runs に達した missing を TRASH 候補にする', () => {
    expect(
      planMissingResources({
        root: census(),
        existing: [resource({ missingCount: 1 })],
        mode: 'full',
        dryRun: false,
      }),
    ).toEqual({
      updates: [{ notionId: 'page-id', missingCount: 2 }],
      trash: [{ notionId: 'page-id', reason: 'confirmed_not_found' }],
    });
  });

  it('census に存在する resource の missing count をリセットする', () => {
    const seen = resource({ missingCount: 1 });
    expect(
      planMissingResources({
        root: census({ resources: [{ notionId: 'page-id' } as never] }),
        existing: [seen],
        mode: 'full',
        dryRun: false,
      }),
    ).toEqual({
      updates: [{ notionId: 'page-id', missingCount: 0 }],
      trash: [],
    });
  });

  it('Notion trashが確認されたresourceもgrace runsまでTRASH候補にしない', () => {
    const trashed = { notionId: 'page-id', inTrash: true } as never;
    expect(
      planMissingResources({
        root: census({ resources: [trashed] }),
        existing: [resource()],
        mode: 'full',
        dryRun: false,
      }),
    ).toEqual({
      updates: [{ notionId: 'page-id', missingCount: 1 }],
      trash: [],
    });
  });

  it('Notion trashの連続確認がgrace runsに達すると理由付きTRASH候補にする', () => {
    const trashed = { notionId: 'page-id', inTrash: true } as never;
    expect(
      planMissingResources({
        root: census({ resources: [trashed] }),
        existing: [resource({ missingCount: 1 })],
        mode: 'full',
        dryRun: false,
      }),
    ).toEqual({
      updates: [{ notionId: 'page-id', missingCount: 2 }],
      trash: [{ notionId: 'page-id', reason: 'notion_in_trash' }],
    });
  });

  it('root外移動が確認されたresourceを理由付きTRASH候補にする', () => {
    expect(
      planMissingResources({
        root: census(),
        existing: [resource()],
        mode: 'full',
        dryRun: false,
        confirmedReasons: new Map([['page-id', 'moved_out_of_scope']]),
      }).trash,
    ).toEqual([{ notionId: 'page-id', reason: 'moved_out_of_scope' }]);
  });
});

describe('assertTrashWithinLimits', () => {
  it('件数または比率が上限を超えたら中止する', () => {
    expect(() =>
      assertTrashWithinLimits({ trashCount: 51, managedCount: 100 }),
    ).toThrowError(/trash safety limit/iu);
    expect(() =>
      assertTrashWithinLimits({ trashCount: 3, managedCount: 10 }),
    ).toThrowError(/trash safety limit/iu);
  });

  it('明示許可があれば大量退避を許可する', () => {
    expect(() =>
      assertTrashWithinLimits({
        trashCount: 51,
        managedCount: 100,
        allowLargeTrash: true,
      }),
    ).not.toThrow();
  });

  it('管理件数0で退避候補があれば安全上限超過として中止する', () => {
    expect(() =>
      assertTrashWithinLimits({ trashCount: 1, managedCount: 0 }),
    ).toThrowError(/trash safety limit/iu);
  });
});
