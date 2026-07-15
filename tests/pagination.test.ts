import { describe, expect, it, vi } from 'vitest';
import { fetchAllPages } from '../src/notion/pagination.js';

describe('fetchAllPages', () => {
  it('has_more が false になるまで cursor を渡して全件を返す', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        results: ['a'],
        has_more: true,
        next_cursor: 'next',
      })
      .mockResolvedValueOnce({
        results: ['b', 'c'],
        has_more: false,
        next_cursor: null,
      });

    await expect(fetchAllPages(fetchPage)).resolves.toEqual(['a', 'b', 'c']);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'next');
  });

  it('継続 cursor が無い不正な応答を拒否する', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ results: [], has_more: true, next_cursor: null });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow(/cursor/i);
  });
});
