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

  it('caption を含む table は変換せず元の HTML を維持する（caption は認識対象外のため）', async () => {
    const input =
      '<table header-row="true"><caption>Important</caption><tr><td>Name</td><td>Score</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('セル間に孤立したテキストがある table は変換せず元の HTML を維持する', async () => {
    const input =
      '<table header-row="true"><tr><td>A</td>ORPHAN<td>B</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('table 終了後に同一 HTML ノード内で別コンテンツが続く場合は変換せず元の HTML を維持する', async () => {
    const input =
      '<table header-row="true"><tr><td>A</td><td>B</td></tr></table>TRAILING';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('行間に未知タグがある table は変換せず元の HTML を維持する', async () => {
    const input =
      '<table header-row="true"><tr><td>A</td><td>B</td></tr><unknown/><tr><td>C</td><td>D</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('<trfoo> のような類似タグは tr として認識せず、table を変換せず元の HTML を維持する', async () => {
    const input = '<table header-row="true"><trfoo><td>A</td></trfoo></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('<tdfoo> のような類似タグは td として認識せず、table を変換せず元の HTML を維持する', async () => {
    const input = '<table header-row="true"><tr><tdfoo>A</tdfoo></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('colgroup が空白と col のみで構成される table は変換する', async () => {
    await expect(
      transformEnhancedMarkdown(
        '<table header-row="true"><colgroup><col><col width="617"></colgroup><tr><td>Name</td><td>Score</td></tr><tr><td>Alice</td><td>90</td></tr></table>',
      ),
    ).resolves.toBe(
      '| Name  | Score |\n| ----- | ----- |\n| Alice | 90    |\n',
    );
  });

  it('colgroup 内に col 以外の未認識コンテンツがある table は変換せず元の HTML を維持する', async () => {
    const input =
      '<table header-row="true"><colgroup>UNEXPECTED<col></colgroup><tr><td>Name</td><td>Score</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('table_of_contents（属性なし）を削除する', async () => {
    await expect(
      transformEnhancedMarkdown('<table_of_contents/>'),
    ).resolves.toBe('');
  });

  it('table_of_contents（属性あり）を削除する', async () => {
    await expect(
      transformEnhancedMarkdown('<table_of_contents color="gray"/>'),
    ).resolves.toBe('');
  });

  it('文書中に複数回出現する table_of_contents を全て削除し、前後の本文を保持する', async () => {
    const input =
      'Before\n\n<table_of_contents/>\n\nMiddle\n\n<table_of_contents color="gray"/>\n\nAfter';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Before\n\nMiddle\n\nAfter\n',
    );
  });

  it('インラインコード・コードフェンス内の table_of_contents という文字列は削除しない', async () => {
    const input = '`<table_of_contents/>`\n\n```\n<table_of_contents/>\n```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(input);
  });

  it('段落途中に現れる table_of_contents を削除し、前後の本文を保持する', async () => {
    await expect(
      transformEnhancedMarkdown('Before <table_of_contents/> after'),
    ).resolves.toBe('Before  after\n');
  });

  it('table_of_contents の直後（空行なし）に本文が続く場合は削除せず元の HTML を維持する', async () => {
    const input = '<table_of_contents/>\nImportant text on the next line';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('削除・変換の対象外のアンダースコア入りタグ（synced_block）は元の綴りを保つ（文字化けしない）', async () => {
    const input = '<synced_block url="https://example.com">Body</synced_block>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('columns内にネストしたsynced_blockも元の綴りを保つ', async () => {
    const input =
      '<columns>\n<column>\n<synced_block url="https://example.com">Body</synced_block>\n</column>\n</columns>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '<synced_block url="https://example.com">Body</synced_block>\n',
    );
  });

  it('callout内にネストしたsynced_blockも元の綴りを保つ', async () => {
    const input =
      '<callout>See <synced_block url="https://example.com">Body</synced_block></callout>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '> [!note]\n> See <synced_block url="https://example.com">Body</synced_block>\n',
    );
  });

  it('table セル内のインラインコードに書かれたタグ状の文字列は元の綴りのまま出力される', async () => {
    const input =
      '<table header-row="true"><tr><td>Name</td><td>Code</td></tr><tr><td>Example</td><td>`<synced_block/>`</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '| Name    | Code              |\n| ------- | ----------------- |\n| Example | `<synced_block/>` |\n',
    );
  });
});
