import { describe, expect, it, vi } from 'vitest';
import type { CensusResource } from '../src/notion/census.js';
import {
  deduplicateDataSourceIds,
  fetchDataSourceRows,
} from '../src/notion/data-sources.js';
import type { NotionClient } from '../src/notion/types.js';

function client(
  queryDataSource: NotionClient['queryDataSource'],
): NotionClient {
  return {
    queryDataSource,
    retrievePage: vi.fn(),
    retrieveDatabase: vi.fn(),
    retrieveMarkdown: vi.fn(),
    listBlockChildren: vi.fn(),
    search: vi.fn(),
  };
}

describe('fetchDataSourceRows', () => {
  it('cursor paginationを完走して全pageを返す', async () => {
    const query = vi.fn((_id: string, cursor?: string) =>
      Promise.resolve(
        cursor
          ? {
              results: [{ object: 'page', id: 'row-2' }],
              has_more: false,
              next_cursor: null,
            }
          : {
              results: [{ object: 'page', id: 'row-1' }],
              has_more: true,
              next_cursor: 'next',
            },
      ),
    );

    await expect(
      fetchDataSourceRows(client(query), 'source-id'),
    ).resolves.toEqual([
      { object: 'page', id: 'row-1' },
      { object: 'page', id: 'row-2' },
    ]);
    expect(query.mock.calls).toEqual([
      ['source-id', undefined],
      ['source-id', 'next'],
    ]);
  });

  it('page以外の結果をvalidation errorにする', async () => {
    await expect(
      fetchDataSourceRows(
        client(() =>
          Promise.resolve({
            results: [{ object: 'database', id: 'unexpected' }],
            has_more: false,
            next_cursor: null,
          }),
        ),
        'source-id',
      ),
    ).rejects.toMatchObject({ category: 'validation' });
  });
});

describe('deduplicateDataSourceIds', () => {
  it('linked viewで重複したData Source IDを初出順で1件にする', () => {
    const resources = [
      { notionId: 'db-1', dataSourceId: 'source-1' },
      { notionId: 'linked-view', dataSourceId: 'source-1' },
      { notionId: 'db-2', dataSourceId: 'source-2' },
      { notionId: 'page' },
    ] as CensusResource[];
    expect(deduplicateDataSourceIds(resources)).toEqual([
      'source-1',
      'source-2',
    ]);
  });
});
