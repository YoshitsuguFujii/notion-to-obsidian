import { describe, expect, it } from 'vitest';
import type { RootCensus } from '../src/notion/census.js';
import { buildCensusPlan } from '../src/sync/planner.js';

const partialCensus: RootCensus = {
  rootId: 'root-id',
  status: 'partial',
  deletionAllowed: false,
  resources: [],
  warnings: [
    {
      type: 'child_list_incomplete',
      resourceId: 'page-id',
      message: 'incomplete',
    },
  ],
};

describe('buildCensusPlan', () => {
  it('path と既存状態から CREATE UPDATE UNCHANGED を組み立てる', () => {
    const census: RootCensus = {
      ...partialCensus,
      status: 'complete',
      deletionAllowed: true,
      warnings: [],
    };
    const paths = [
      {
        notionId: 'create',
        expectedPath: 'Create.md',
        resolvedFilename: 'Create',
      },
      { notionId: 'update', expectedPath: 'New.md', resolvedFilename: 'New' },
      { notionId: 'same', expectedPath: 'Same.md', resolvedFilename: 'Same' },
    ];
    const existing = new Map([
      ['update', { expectedPath: 'Old.md' }],
      ['same', { expectedPath: 'Same.md' }],
    ]);

    expect(buildCensusPlan(census, paths, existing).actions).toEqual([
      { type: 'CREATE', notionId: 'create', expectedPath: 'Create.md' },
      { type: 'UPDATE', notionId: 'update', expectedPath: 'New.md' },
      { type: 'UNCHANGED', notionId: 'same', expectedPath: 'Same.md' },
    ]);
  });

  it('partial census から削除系 action を生成しない', () => {
    const plan = buildCensusPlan(
      partialCensus,
      [{ notionId: 'seen', expectedPath: 'Seen.md', resolvedFilename: 'Seen' }],
      new Map([['missing-from-census', { expectedPath: 'Old.md' }]]),
    );

    expect(plan.deletionAllowed).toBe(false);
    expect(plan.actions).toContainEqual({
      type: 'WARNING',
      notionId: 'page-id',
      message: 'incomplete',
    });
    expect(plan.actions.map(({ type }) => type)).not.toContain('TRASH');
    expect(plan.actions.map(({ notionId }) => notionId)).not.toContain(
      'missing-from-census',
    );
  });

  it('partial status では不整合な deletionAllowed 入力も無効化する', () => {
    const plan = buildCensusPlan(
      { ...partialCensus, deletionAllowed: true },
      [],
    );

    expect(plan.deletionAllowed).toBe(false);
  });
});
