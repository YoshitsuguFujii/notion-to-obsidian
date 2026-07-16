import { describe, expect, it, vi } from 'vitest';
import type { NotionClient } from '../src/notion/types.js';
import { censusRoot } from '../src/notion/census.js';
import { planResourcePaths } from '../src/domain/path-plan.js';

const rootPage = {
  object: 'page',
  id: 'root',
  last_edited_time: '2026-07-10T00:00:00.000Z',
  in_trash: false,
  url: 'https://notion.so/root',
  parent: { type: 'workspace', workspace: true },
  properties: { title: { type: 'title', title: [{ plain_text: 'Root' }] } },
};

function client(overrides: Partial<NotionClient> = {}): NotionClient {
  return {
    retrievePage: vi.fn().mockResolvedValue(rootPage),
    retrieveDatabase: vi.fn(),
    retrieveMarkdown: vi.fn(),
    listBlockChildren: vi
      .fn()
      .mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
    queryDataSource: vi.fn(),
    search: vi
      .fn()
      .mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
    ...overrides,
  };
}

function childDatabase(id: string, title: string, parentId: string) {
  return {
    object: 'block',
    id,
    type: 'child_database',
    child_database: { title },
    parent: { type: 'page_id', page_id: parentId },
    last_edited_time: '2026-07-11T00:00:00.000Z',
    in_trash: false,
  };
}

function childPage(id: string, title: string, parentId: string) {
  return {
    object: 'block',
    id,
    type: 'child_page',
    child_page: { title },
    parent: { type: 'page_id', page_id: parentId },
    last_edited_time: '2026-07-11T00:00:00.000Z',
    in_trash: false,
  };
}

function childBlock(id: string, type = 'toggle') {
  return {
    object: 'block',
    id,
    type,
    [type]: {},
    has_children: true,
  };
}

describe('censusRoot', () => {
  it('同期ルートを外部の親から切り離して最上位のパスに配置する', async () => {
    const retrievePage = vi.fn().mockResolvedValue({
      ...rootPage,
      parent: { type: 'page_id', page_id: 'outside' },
    });

    const result = await censusRoot(client({ retrievePage }), 'root');

    expect(() => planResourcePaths(result.resources)).not.toThrow();
    expect(result.resources[0]).toMatchObject({
      notionId: 'root',
      parentType: 'workspace',
    });
    expect(result.resources[0]).not.toHaveProperty('parentId');
  });

  it('一般ブロック内にネストした子ページを発見する', async () => {
    const listBlockChildren = vi.fn((id: string) =>
      Promise.resolve({
        results:
          id === 'root'
            ? [childBlock('toggle')]
            : id === 'toggle'
              ? [childPage('nested', 'Nested', 'root')]
              : [],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await censusRoot(client({ listBlockChildren }), 'root');

    expect(result.resources).toContainEqual(
      expect.objectContaining({ notionId: 'nested', title: 'Nested' }),
    );
    expect(result.status).toBe('complete');
  });

  it('循環する一般ブロックを一度ずつ探索して完了する', async () => {
    const listBlockChildren = vi.fn((id: string) =>
      Promise.resolve({
        results:
          id === 'root'
            ? [childBlock('block-a', 'synced_block')]
            : id === 'block-a'
              ? [childBlock('block-b', 'synced_block')]
              : id === 'block-b'
                ? [childBlock('block-a', 'synced_block')]
                : [],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await censusRoot(client({ listBlockChildren }), 'root');

    expect(result.status).toBe('complete');
    expect(listBlockChildren.mock.calls.map(([id]) => id)).toEqual([
      'root',
      'block-a',
      'block-b',
    ]);
  });

  it('一般ブロックの子取得に失敗したcensusをpartialとして削除判定を許可しない', async () => {
    const listBlockChildren = vi.fn((id: string) => {
      if (id === 'toggle')
        return Promise.reject(new Error('service unavailable'));
      return Promise.resolve({
        results: id === 'root' ? [childBlock('toggle')] : [],
        has_more: false,
        next_cursor: null,
      });
    });

    const result = await censusRoot(client({ listBlockChildren }), 'root');

    expect(result).toMatchObject({
      status: 'partial',
      deletionAllowed: false,
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'child_list_incomplete',
        resourceId: 'toggle',
      }),
    );
  });

  it('database取得結果からData Source IDを解決する', async () => {
    const listBlockChildren = vi.fn((id: string) =>
      Promise.resolve({
        results:
          id === 'root' ? [childDatabase('database', 'Tasks', 'root')] : [],
        has_more: false,
        next_cursor: null,
      }),
    );
    const retrieveDatabase = vi.fn().mockResolvedValue({
      id: 'database',
      data_sources: [{ id: 'source', name: 'Tasks' }],
    });

    const result = await censusRoot(
      client({ listBlockChildren, retrieveDatabase }),
      'root',
    );

    expect(result.resources).toContainEqual(
      expect.objectContaining({
        notionId: 'database',
        objectType: 'database',
        dataSourceId: 'source',
      }),
    );
    expect(result.status).toBe('complete');
    expect(retrieveDatabase).toHaveBeenCalledOnce();
  });

  it('database取得に失敗したcensusをpartialとして削除判定を許可しない', async () => {
    const listBlockChildren = vi.fn((id: string) =>
      Promise.resolve({
        results:
          id === 'root' ? [childDatabase('database', 'Tasks', 'root')] : [],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await censusRoot(
      client({
        listBlockChildren,
        retrieveDatabase: vi
          .fn()
          .mockRejectedValue(new Error('service unavailable')),
      }),
      'root',
    );

    expect(result).toMatchObject({
      status: 'partial',
      deletionAllowed: false,
      warnings: [
        expect.objectContaining({
          type: 'database_retrieve_failed',
          resourceId: 'database',
        }),
      ],
    });
  });

  it('複数Data Sourceを持つdatabaseでは先頭を採用して警告する', async () => {
    const listBlockChildren = vi.fn((id: string) =>
      Promise.resolve({
        results:
          id === 'root' ? [childDatabase('database', 'Tasks', 'root')] : [],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await censusRoot(
      client({
        listBlockChildren,
        retrieveDatabase: vi.fn().mockResolvedValue({
          id: 'database',
          data_sources: [
            { id: 'source-primary', name: 'Tasks' },
            { id: 'source-secondary', name: 'Archive' },
          ],
        }),
      }),
      'root',
    );

    expect(result.resources).toContainEqual(
      expect.objectContaining({
        notionId: 'database',
        dataSourceId: 'source-primary',
      }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'multiple_data_sources',
        resourceId: 'database',
      }),
    );
  });

  it('親の更新日時に関係なく全 cursor と子階層を探索する', async () => {
    const listBlockChildren = vi.fn((id: string, cursor?: string) => {
      if (id === 'root' && cursor === undefined)
        return Promise.resolve({
          results: [childPage('child', 'Child', 'root')],
          has_more: true,
          next_cursor: 'page-2',
        });
      if (id === 'root' && cursor === 'page-2')
        return Promise.resolve({
          results: [childPage('sibling', 'Sibling', 'root')],
          has_more: false,
          next_cursor: null,
        });
      if (id === 'child')
        return Promise.resolve({
          results: [childPage('grandchild', 'Grandchild', 'child')],
          has_more: false,
          next_cursor: null,
        });
      return Promise.resolve({
        results: [],
        has_more: false,
        next_cursor: null,
      });
    });

    const result = await censusRoot(client({ listBlockChildren }), 'root');

    expect(result.status).toBe('complete');
    expect(result.deletionAllowed).toBe(true);
    expect(result.resources.map(({ notionId }) => notionId)).toEqual([
      'root',
      'child',
      'sibling',
      'grandchild',
    ]);
    expect(listBlockChildren).toHaveBeenCalledWith('child', undefined);
  });

  it('循環と複数経路で同じページを一度だけ探索する', async () => {
    const listBlockChildren = vi.fn((id: string) =>
      Promise.resolve({
        results:
          id === 'root'
            ? [
                childPage('child', 'Child', 'root'),
                childPage('child', 'Child', 'root'),
              ]
            : [childPage('root', 'Root', 'child')],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await censusRoot(client({ listBlockChildren }), 'root');

    expect(result.resources.map(({ notionId }) => notionId)).toEqual([
      'root',
      'child',
    ]);
    expect(listBlockChildren).toHaveBeenCalledTimes(2);
  });

  it('途中の探索失敗を partial とし削除判定を許可しない', async () => {
    const listBlockChildren = vi.fn((id: string) => {
      if (id === 'child')
        return Promise.reject(new Error('service unavailable'));
      return Promise.resolve({
        results: [childPage('child', 'Child', 'root')],
        has_more: false,
        next_cursor: null,
      });
    });

    const result = await censusRoot(client({ listBlockChildren }), 'root');

    expect(result.status).toBe('partial');
    expect(result.deletionAllowed).toBe(false);
    expect(result.resources.map(({ notionId }) => notionId)).toEqual([
      'root',
      'child',
    ]);
  });

  it('root retrieve 失敗を partial とし既存 resource の削除根拠を返さない', async () => {
    const result = await censusRoot(
      client({ retrievePage: vi.fn().mockRejectedValue(new Error('denied')) }),
      'root',
    );

    expect(result).toMatchObject({
      status: 'partial',
      deletionAllowed: false,
      resources: [],
    });
  });

  it('Search 候補の parent chain が root に到達した取りこぼしだけを partial にする', async () => {
    const retrievePage = vi.fn((id: string) => {
      if (id === 'root') return Promise.resolve(rootPage);
      if (id === 'missing')
        return Promise.resolve({
          object: 'page',
          id,
          parent: { type: 'page_id', page_id: 'parent' },
        });
      return Promise.resolve({
        object: 'page',
        id: 'parent',
        parent: { type: 'page_id', page_id: 'root' },
      });
    });
    const search = vi.fn().mockResolvedValue({
      results: [{ object: 'page', id: 'missing' }],
      has_more: false,
      next_cursor: null,
    });

    const result = await censusRoot(client({ retrievePage, search }), 'root');

    expect(result.status).toBe('partial');
    expect(result.deletionAllowed).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'search_missed_resource',
        resourceId: 'missing',
      }),
    );
  });

  it('Searchに失敗したcensusをpartialとして削除判定を許可しない', async () => {
    const result = await censusRoot(
      client({
        search: vi.fn().mockRejectedValue(new Error('search unavailable')),
      }),
      'root',
    );

    expect(result.status).toBe('partial');
    expect(result.deletionAllowed).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'search_incomplete',
        resourceId: 'root',
      }),
    );
  });

  it('Search候補の親を取得できないcensusをpartialとして削除判定を許可しない', async () => {
    const retrievePage = vi.fn((id: string) =>
      id === 'root'
        ? Promise.resolve(rootPage)
        : Promise.reject(new Error('service unavailable')),
    );
    const search = vi.fn().mockResolvedValue({
      results: [{ object: 'page', id: 'unknown-descendant' }],
      has_more: false,
      next_cursor: null,
    });

    const result = await censusRoot(client({ retrievePage, search }), 'root');

    expect(result).toMatchObject({
      status: 'partial',
      deletionAllowed: false,
    });
  });

  it('Search候補の親チェーンが循環するcensusをpartialとして削除判定を許可しない', async () => {
    const retrievePage = vi.fn((id: string) => {
      if (id === 'root') return Promise.resolve(rootPage);
      return Promise.resolve({
        object: 'page',
        id,
        parent: {
          type: 'page_id',
          page_id: id === 'loop-a' ? 'loop-b' : 'loop-a',
        },
      });
    });
    const search = vi.fn().mockResolvedValue({
      results: [{ object: 'page', id: 'loop-a' }],
      has_more: false,
      next_cursor: null,
    });

    const result = await censusRoot(client({ retrievePage, search }), 'root');

    expect(result).toMatchObject({
      status: 'partial',
      deletionAllowed: false,
    });
  });

  it('Search 候補の parent chain が別 root で終わる場合は判断根拠にしない', async () => {
    const retrievePage = vi.fn((id: string) =>
      Promise.resolve(
        id === 'root'
          ? rootPage
          : {
              object: 'page',
              id,
              parent: { type: 'workspace', workspace: true },
            },
      ),
    );
    const search = vi.fn().mockResolvedValue({
      results: [{ object: 'page', id: 'same-title-other-root' }],
      has_more: false,
      next_cursor: null,
    });

    const result = await censusRoot(client({ retrievePage, search }), 'root');

    expect(result.status).toBe('complete');
    expect(result.deletionAllowed).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
