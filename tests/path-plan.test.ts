import { describe, expect, it } from 'vitest';
import type { CensusResource } from '../src/notion/census.js';
import { planResourcePaths } from '../src/domain/path-plan.js';

function page(
  notionId: string,
  title: string,
  parentId?: string,
): CensusResource {
  return {
    notionId,
    objectType: 'page',
    title,
    ...(parentId
      ? { parentId, parentType: 'page' as const }
      : { parentType: 'workspace' as const }),
    rootId: 'root-id',
    lastEditedTime: '2026-07-11T00:00:00.000Z',
    inTrash: false,
    url: '',
  };
}

describe('planResourcePaths', () => {
  it('page と child folder の階層を再現する', () => {
    const paths = planResourcePaths([
      page('root-id', '開発'),
      page('rails-id', 'Rails', 'root-id'),
      page('turbo-id', 'Turbo', 'rails-id'),
    ]);

    expect(paths).toEqual([
      {
        notionId: 'root-id',
        expectedPath: '開発.md',
        resolvedFilename: '開発',
      },
      {
        notionId: 'rails-id',
        expectedPath: '開発/Rails.md',
        resolvedFilename: 'Rails',
      },
      {
        notionId: 'turbo-id',
        expectedPath: '開発/Rails/Turbo.md',
        resolvedFilename: 'Turbo',
      },
    ]);
  });

  it('同一親でサニタイズ後に衝突した名前の一方だけに ID suffix を付ける', () => {
    const resources = [
      page('root-id', 'Root'),
      page('b2b2b2b2-rest', 'メモ?', 'root-id'),
      page('a1a1a1a1-rest', 'メモ*', 'root-id'),
    ];

    const first = planResourcePaths(resources);
    const second = planResourcePaths([...resources].reverse());

    expect(first).toEqual(second);
    expect(first).toEqual(
      expect.arrayContaining([
        {
          notionId: 'a1a1a1a1-rest',
          expectedPath: 'Root/メモ-.md',
          resolvedFilename: 'メモ-',
        },
        {
          notionId: 'b2b2b2b2-rest',
          expectedPath: 'Root/メモ---b2b2b2b2.md',
          resolvedFilename: 'メモ---b2b2b2b2',
        },
      ]),
    );
  });

  it('衝突しない名前には ID suffix を付けない', () => {
    const paths = planResourcePaths([
      page('root-id', 'Root'),
      page('child-id', 'Unique', 'root-id'),
    ]);

    expect(paths[1]).toMatchObject({
      resolvedFilename: 'Unique',
      expectedPath: 'Root/Unique.md',
    });
  });

  it('state に保存済みの衝突解決名を再利用する', () => {
    const paths = planResourcePaths(
      [page('root-id', 'Root'), page('b2b2b2b2-rest', 'メモ', 'root-id')],
      {
        previousResolvedFilenames: new Map([
          ['b2b2b2b2-rest', 'メモ--b2b2b2b2'],
        ]),
      },
    );

    expect(paths[1]).toMatchObject({
      resolvedFilename: 'メモ--b2b2b2b2',
      expectedPath: 'Root/メモ--b2b2b2b2.md',
    });
  });

  it('タイトルが変わった場合は保存済みの衝突解決名を引き継がない', () => {
    const paths = planResourcePaths(
      [page('root-id', 'Root'), page('b2b2b2b2-rest', 'Renamed', 'root-id')],
      {
        previousResolvedFilenames: new Map([
          ['b2b2b2b2-rest', 'メモ--b2b2b2b2'],
        ]),
      },
    );

    expect(paths[1]).toMatchObject({
      resolvedFilename: 'Renamed',
      expectedPath: 'Root/Renamed.md',
    });
  });

  it('親が入力に存在しない resource を拒否する', () => {
    expect(() =>
      planResourcePaths([page('child-id', 'Child', 'missing')]),
    ).toThrow(/parent/i);
  });
});
