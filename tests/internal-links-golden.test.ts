import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolveInternalLinks } from '../src/transform/obsidian-links.js';

describe('internal links golden', () => {
  it('同名ページをタイトルでなくIDごとの期待パスへ解決する', async () => {
    const input = await readFile(
      new URL('./fixtures/internal-links-input.md', import.meta.url),
      'utf8',
    );
    const expected = await readFile(
      new URL('./fixtures/internal-links-expected.md', import.meta.url),
      'utf8',
    );
    const paths = new Map([
      ['11111111-1111-1111-1111-111111111111', 'Root/Memo.md'],
      ['22222222-2222-2222-2222-222222222222', 'Root/Memo--22222222.md'],
      ['33333333-3333-3333-3333-333333333333', 'Other/Page.md'],
    ]);

    expect(await resolveInternalLinks(input, paths)).toBe(expected);
  });
});
