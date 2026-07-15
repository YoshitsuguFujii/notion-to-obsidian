import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { transformEnhancedMarkdown } from '../src/transform/enhanced-markdown.js';

describe('transformEnhancedMarkdown', () => {
  it('Enhanced Markdown を AST で Obsidian Markdown へ変換する', async () => {
    const input = await readFile(
      new URL('./fixtures/enhanced-markdown-input.md', import.meta.url),
      'utf8',
    );
    const expected = await readFile(
      new URL('./fixtures/enhanced-markdown-expected.md', import.meta.url),
      'utf8',
    );

    expect(await transformEnhancedMarkdown(input)).toBe(expected);
  });

  it('種別不明の callout を note として変換する', async () => {
    await expect(
      transformEnhancedMarkdown('<callout>Body</callout>'),
    ).resolves.toBe('> [!note]\n> Body\n');
  });
});
