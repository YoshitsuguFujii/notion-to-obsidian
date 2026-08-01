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

  it('header-row="true" の table を、先頭行をヘッダーとした Markdown テーブルへ変換する', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true"><tr><td>Name</td><td>Score</td></tr><tr><td>Alice</td><td>90</td></tr></table>',
      ),
    ).resolves.toBe(
      '| Name  | Score |\n| ----- | ----- |\n| Alice | 90    |\n',
    );
  });

  it('header-row 属性がない table は、空のヘッダー行を合成した Markdown テーブルへ変換する', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table><tr><td>Alice</td><td>90</td></tr><tr><td>Bob</td><td>80</td></tr></table>',
      ),
    ).resolves.toBe(
      '|       |    |\n| ----- | -- |\n| Alice | 90 |\n| Bob   | 80 |\n',
    );
  });

  it('header-column="true" のみの table は、データを保持しつつ空のヘッダー行として扱う', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-column="true"><tr><td>Alice</td><td>90</td></tr></table>',
      ),
    ).resolves.toBe('|       |    |\n| ----- | -- |\n| Alice | 90 |\n');
  });

  it('header-row="true" と header-column="true" が両方ある table は、先頭行をヘッダーとして変換する', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true" header-column="true"><tr><td>Name</td><td>Score</td></tr><tr><td>Alice</td><td>90</td></tr></table>',
      ),
    ).resolves.toBe(
      '| Name  | Score |\n| ----- | ----- |\n| Alice | 90    |\n',
    );
  });

  it('空セルを持つ table を正しく変換する', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true"><tr><td>Name</td><td>Score</td></tr><tr><td>Alice</td><td></td></tr></table>',
      ),
    ).resolves.toBe(
      '| Name  | Score |\n| ----- | ----- |\n| Alice |       |\n',
    );
  });

  it('セル内の bold と改行が Markdown として機能する table へ変換する（テーブル構造を壊さない）', async () => {
    const output = await transformEnhancedMarkdown(
      '<table header-row="true"><tr><td>Name</td><td>Note</td></tr><tr><td>**Alice**</td><td>Line one<br>Line two</td></tr></table>',
    );
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('**Alice**');
    expect(lines[2]).toContain('Line one<br>Line two');
  });

  it('セル内の | 文字を \\| へエスケープする', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true"><tr><td>Name</td><td>Note</td></tr><tr><td>Alice</td><td>a|b</td></tr></table>',
      ),
    ).resolves.toBe('| Name  | Note |\n| ----- | ---- |\n| Alice | a\\|b |\n');
  });

  it('colspan を持つ table は変換せず元の HTML を維持する', async () => {
    const input =
      '<table header-row="true"><tr><td colspan="2">Merged</td></tr><tr><td>Alice</td><td>90</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('rowspan を持つ table は変換せず元の HTML を維持する', async () => {
    const input =
      '<table header-row="true"><tr><td rowspan="2">Alice</td><td>90</td></tr><tr><td>80</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('行内に <th> が混在する table は変換せず元の HTML を維持する（td 数だけでは列数不一致を検出できないため）', async () => {
    const input =
      '<table header-row="true"><tr><th>Name</th><td>Score</td></tr><tr><th>Alice</th><td>90</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('セル内で既にエスケープ済みの \\| はそのまま維持する（二重エスケープしない）', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true"><tr><td>Name</td><td>Note</td></tr><tr><td>Alice</td><td>a\\|b</td></tr></table>',
      ),
    ).resolves.toBe('| Name  | Note |\n| ----- | ---- |\n| Alice | a\\|b |\n');
  });

  it('セル内のパイプに関係しないバックスラッシュ（Markdown のエスケープ記法）を壊さない', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true"><tr><td>Name</td><td>Note</td></tr><tr><td>Alice</td><td>\\*not bold\\*</td></tr></table>',
      ),
    ).resolves.toBe(
      '| Name  | Note         |\n| ----- | ------------ |\n| Alice | \\*not bold\\* |\n',
    );
  });
});
