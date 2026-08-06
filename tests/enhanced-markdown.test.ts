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

  it('synced_blockはタグを外し中身をそのまま段落として残す', async () => {
    const input = '<synced_block url="https://example.com">Body</synced_block>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe('Body\n');
  });

  it('synced_block_referenceは本文を展開し、閉じタグ後の本文を保持する', async () => {
    const input =
      '<synced_block_reference url="https://example.com">\nBody\n</synced_block_reference>\nTrailing';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Body\n\nTrailing\n',
    );
  });

  it('段落中間のcalloutを前後の本文を保って独立したブロックへ展開する', async () => {
    const input = 'Before\n<callout>Note</callout>\nAfter';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Before\n\n> [!note]\n> Note\n\nAfter\n',
    );
  });

  it('段落中間のcallout内の取り消し線を保持して展開する', async () => {
    const input = 'Before <callout>~~struck~~</callout> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Before\n\n> [!note]\n> ~~struck~~\n\nAfter\n',
    );
  });

  it('段落中間のsynced_block内calloutと前後の装飾付き本文を展開する', async () => {
    const input =
      'Before <span color="orange">**Composition**</span> and <span underline="true">compose</span>.\n<synced_block url="https://example.com">\n<callout icon="💡">\n**Principle**\nPrefer composition\n</callout>\n</synced_block>\nAfter';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Before ==**Composition**== and <u>compose</u>.\n\n> [!note]\n> **Principle**\n> Prefer composition\n\nAfter\n',
    );
  });

  it('同一段落内の複数calloutを出現順に展開する', async () => {
    const input =
      'Before <callout>First</callout> Middle <callout>Second</callout> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Before\n\n> [!note]\n> First\n\nMiddle\n\n> [!note]\n> Second\n\nAfter\n',
    );
  });

  it('入れ子のsynced_blockを対応する閉じタグまで展開する', async () => {
    const input =
      'Before <synced_block url="outer">Outer <synced_block url="inner">Inner</synced_block> Tail</synced_block> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Before\n\nOuter\n\nInner\n\nTail\n\nAfter\n',
    );
  });

  it('対応関係を確定できない段落中間の既知タグは本文とともに保持する', async () => {
    const input =
      'Before <callout>Note <synced_block url="x"></callout></synced_block> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('閉じタグがない段落中間の既知タグは本文とともに保持する', async () => {
    const input = 'Before <callout>Note After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('対応する開始タグがない段落中間の閉じタグは本文とともに保持する', async () => {
    const input = 'Before Note</callout> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('calloutに別のcalloutが入れ子の場合は本文とともに保持する', async () => {
    const input =
      'Before <callout>Outer <callout>Inner</callout></callout> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('calloutに似た未知タグは変換せず本文を保持する', async () => {
    const input = 'Before <calloutish>Note</calloutish> After';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('codeとinlineCode内のsynced_block_reference状文字列を変更しない', async () => {
    const input =
      'Inline `<synced_block_reference>text</synced_block_reference>`\n\n```text\n<synced_block_reference>text</synced_block_reference>\n```';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('fragment内のcodeとinlineCodeにあるハイフン形参照タグを変更しない', async () => {
    const input =
      '<columns>\n<column>\n`<synced-block-reference>`\n\n```text\n<synced-block-reference>\n```\n</column>\n</columns>';

    const output = await transformEnhancedMarkdown(input);

    expect(output).toContain('`<synced-block-reference>`');
    expect(output).toContain('```text\n<synced-block-reference>\n```');
    expect(output).not.toContain('<synced_block-reference>');
  });

  it('空のsynced_blockはエラーにならず何も残さない', async () => {
    const input = '<synced_block url="https://example.com"></synced_block>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe('');
  });

  it('synced_block内のcalloutは展開後も既存のEnhanced Markdown変換が適用される', async () => {
    const input =
      '<synced_block url="https://example.com">\n<callout icon="💡">Note</callout>\n</synced_block>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '> [!note]\n> Note\n',
    );
  });

  it('synced_block終了タグ直後（空行なし）に本文が続く場合もtrailingを失わず展開し、後続本文を独立した段落として保全する', async () => {
    const input =
      '<synced_block url="https://example.com">\nBody\n</synced_block>\nTrailing text';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'Body\n\nTrailing text\n',
    );
  });

  it('synced_blockのtrailingに崩壊コードフェンスがあっても正しく修復される', async () => {
    const input =
      '<synced_block url="https://example.com">\nBody\n</synced_block>\n1. text\n   ```javascript\nconsole.log(1);\nconsole.log(2);\n   ```\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('Body');
    expect(output).toContain('console.log(1);');
    expect(output).toContain('console.log(2);');
    expect(output).not.toContain('\\`\\`\\`');
  });

  it('同じHTMLブロックに複数のsynced_blockが続く場合、それぞれの対応する閉じタグまでを展開する', async () => {
    const input = await readFile(
      new URL('./fixtures/multiple-synced-blocks-input.md', import.meta.url),
      'utf8',
    );
    const expected = await readFile(
      new URL('./fixtures/multiple-synced-blocks-expected.md', import.meta.url),
      'utf8',
    );

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(expected);
  });

  it('対応する閉じタグを一意に判別できないsynced_blockは展開せず内容を保持する', async () => {
    const input =
      '<synced_block url="outer">\n<synced_block url="inner">\nInner\n</synced_block>\nTrailing';

    const output = await transformEnhancedMarkdown(input);

    expect(output).toContain('<synced_block url="outer">');
    expect(output).toContain('<synced_block url="inner">');
    expect(output).toContain('Inner');
    expect(output).toContain('</synced_block>');
    expect(output).toContain('Trailing');
  });

  it('別要素の引用符付き属性にsynced_blockの閉じタグ状文字列があっても外側の対応する閉じタグまでを展開する', async () => {
    const input =
      '<synced_block url="outer">\n<div data-value="</synced_block>">Attribute</div>\nBody after attribute\n</synced_block>\nTrailing';

    const output = await transformEnhancedMarkdown(input);

    expect(output).toBe(
      '<div data-value="</synced_block>">Attribute</div>\nBody after attribute\n\nTrailing\n',
    );
  });

  it('HTMLコメントにsynced_blockの閉じタグ状文字列があっても外側の対応する閉じタグまでを展開する', async () => {
    const input =
      '<synced_block url="outer">\n<!-- </synced_block> -->\nBody after comment\n</synced_block>\nTrailing';

    const output = await transformEnhancedMarkdown(input);

    expect(output).toBe(
      '<!-- </synced_block> -->\n\nBody after comment\n\nTrailing\n',
    );
  });

  it('CDATAにsynced_blockの閉じタグ状文字列があっても外側の対応する閉じタグまでを展開する', async () => {
    const input =
      '<synced_block url="outer">\n<![CDATA[</synced_block>]]>\nBody after CDATA\n</synced_block>\nTrailing';

    const output = await transformEnhancedMarkdown(input);

    expect(output).toBe(
      '<![CDATA[</synced_block>]]>\n\nBody after CDATA\n\nTrailing\n',
    );
  });

  it('小文字化で長さが変わるUnicode文字が本文にあっても外側の対応する閉じタグまでを展開する', async () => {
    const input =
      '<synced_block url="outer">\nİ before boundary\n</synced_block>\nTrailing';

    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'İ before boundary\n\nTrailing\n',
    );
  });

  it('HTMLノード境界をまたぐ崩壊コードフェンスは内容を失わず安全側で未修復のまま保持する', async () => {
    const input =
      '<synced_block url="first">\n<callout>First note</callout>\n</synced_block>\nBetween\n<synced_block url="second">\n<callout>Second note</callout>\n</synced_block>\n- item\n  <callout>Nested note\n</callout>\n1. code example\n   ```plain text\npublic abstract class Duck {\n  QuackBehabior quackBehavior;\n\n  public void performQuack() {\n    quackBehavior.quack();\n  }\n}\n   ```\nAfter';

    const output = await transformEnhancedMarkdown(input);

    // 開始フェンスがHTML fragment、終了フェンスが元文書の次ノードに
    // 分断される構造は未対応である。誤った範囲をコード化せず、著者の
    // 本文を保全するfail-closedの特性を、境界対応の設計が決まるまで固定する。
    expect(output).toContain('QuackBehabior quackBehavior;');
    expect(output).toContain('public void performQuack()');
    expect(output).toContain('```plain text\n   ```');
    expect(output).toContain('```\nAfter\n```');
  });

  it('columns内にネストしたsynced_blockも元の綴りを保つ', async () => {
    const input =
      '<columns>\n<column>\n<synced_block url="https://example.com">Body</synced_block>\n</column>\n</columns>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '<synced_block url="https://example.com">Body</synced_block>\n',
    );
  });

  it('callout内にネストしたsynced_blockを本文として展開する', async () => {
    const input =
      '<callout>See <synced_block url="https://example.com">Body</synced_block></callout>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '> [!note]\n> See\n>\n> Body\n',
    );
  });

  it('table セル内のインラインコードに書かれたタグ状の文字列は元の綴りのまま出力される', async () => {
    const input =
      '<table header-row="true"><tr><td>Name</td><td>Code</td></tr><tr><td>Example</td><td>`<synced_block/>`</td></tr></table>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '| Name    | Code              |\n| ------- | ----------------- |\n| Example | `<synced_block/>` |\n',
    );
  });

  it('synced_block内のインラインコードに著者が書いたハイフン形のタグ状文字列は書き換えない', async () => {
    const input =
      '<synced_block url="a">before `<synced-block>` after</synced_block>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'before `<synced-block>` after\n',
    );
  });

  it('span の color 属性のみを Obsidian ハイライト記法へ変換する', async () => {
    const input = '<span color="orange">text</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe('==text==\n');
  });

  it('span の underline="true" 属性のみを下線タグへ変換する', async () => {
    const input = '<span underline="true">text</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '<u>text</u>\n',
    );
  });

  it('span の color と underline が両方ある場合、両方を重ねて適用する', async () => {
    const input = '<span color="orange" underline="true">text</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '<u>==text==</u>\n',
    );
  });

  it('span の discussion-urls 属性のみの場合、タグだけ外し中身を保持する', async () => {
    const input = '<span discussion-urls="a,b">text</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe('text\n');
  });

  it('span の color と discussion-urls が併存する場合、color 変換を適用し discussion-urls は無視する', async () => {
    const input = '<span color="orange" discussion-urls="a,b">text</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe('==text==\n');
  });

  it('color/underline/discussion-urls のいずれも持たない span は変換せず元の HTML を維持する', async () => {
    const input = '<span class="foo">text</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('インラインコード内の span 状の文字列は変換しない', async () => {
    const input = '`<span class="foo">text</span>`';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('終了タグが同一 children 配列内に見つからない span は変換せず開始タグを維持する', async () => {
    const input = 'before <span color="red">text after';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('中身が空の span は何も残さない', async () => {
    const input = '<span color="red"></span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe('');
  });

  it('開始タグ直後（空行なし）に本文が続く span は変換せず元の HTML を維持する', async () => {
    const input = '<span color="red">\nhello\n\nworld\n\n</span>';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '<span color="red">\nhello\n\nworld\n\n</span>\n',
    );
  });

  it('コードフェンス内の span 状の文字列は変換しない', async () => {
    const input = '```\n<span class="foo">text</span>\n```';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('同一段落内に複数の span が存在する場合、それぞれ個別に正しく変換する', async () => {
    const input =
      'A <span color="red">B</span> C <span underline="true">D</span> E';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'A ==B== C <u>D</u> E\n',
    );
  });

  it('全角読点直後の**太字**が正しくstrongとして認識される', async () => {
    const input = '限り**、実行時に変更する**ことができる';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '限り**、実行時に変更する**ことができる\n',
    );
  });

  it('句読点の種類（。」』）が直後にある場合も正しく認識される', async () => {
    await expect(transformEnhancedMarkdown('前**。後**続')).resolves.toBe(
      '前**。後**続\n',
    );
    await expect(transformEnhancedMarkdown('前**」後**続')).resolves.toBe(
      '前**」後**続\n',
    );
    await expect(transformEnhancedMarkdown('前**』後**続')).resolves.toBe(
      '前**』後**続\n',
    );
  });

  it('開始**の直前が句読点自体の場合も正しくstrongとして認識される', async () => {
    const input = '。**、text**続く';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '。**、text**続く\n',
    );
  });

  it('文頭にある**も正しくstrongとして認識される', async () => {
    const input = '**、text**続く';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '**、text**続く\n',
    );
  });

  it('対をなす終了**がない**は本文としてそのまま保全される', async () => {
    const input = 'text**';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toBe('text\\*\\*\n');
    expect(output).not.toContain('\u200B');
  });

  it('コードフェンス内の全角読点隣接**は変換しない', async () => {
    const input = '```\n限り**、text**続く\n```';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('インラインコード内の全角読点隣接**は変換しない', async () => {
    const input = '`限り**、text**続く`';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(`${input}\n`);
  });

  it('最終出力に不可視文字が残らない', async () => {
    const input = '限り**、実行時に変更する**ことができる';
    const output = await transformEnhancedMarkdown(input);
    expect(output).not.toContain('\u200B');
  });

  it('終了**の直後に句読点が続く場合も既存の強調が壊れない（回帰）', async () => {
    const input = 'これは**太字**、です';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      'これは**太字**、です\n',
    );
  });

  it('番号付きリスト内で崩壊したコードフェンスが正しいcodeブロックとして復元される', async () => {
    const input =
      '1. text\n   ```javascript\nconsole.log(1);\nconsole.log(2);\n   ```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```javascript\n   console.log(1);\n   console.log(2);\n   ```\n',
    );
  });

  it('リスト項目内に意図的に書かれた空のコードブロックは変換されない', async () => {
    const input = '1. text\n\n   ```js\n   ```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(input);
  });

  it('意図的な空コードブロックの後に他の本文・別のコードブロックが続いても誤って吸収しない', async () => {
    const input =
      '1. text\n\n   ```js\n   ```\n\nSome paragraph.\n\n```\nplain code\n```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(input);
  });

  it('リスト外（トップレベル）の通常のコードフェンスは変更されない', async () => {
    const input = '```js\nconsole.log(1);\n```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(input);
  });

  it('復元後のコード本文にMarkdown特殊文字がエスケープされず保持される', async () => {
    const input =
      '1. text\n   ```js\n**not bold** `inline` # heading\n   ```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```js\n   **not bold** `inline` # heading\n   ```\n',
    );
  });

  it('崩壊したコードフェンスの直後に本文が続く場合、コードを復元しつつ後続本文も保持する', async () => {
    const input =
      '1. text\n   ```js\nline1\nline2\n   ```\n\nAfter list paragraph.\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```js\n   line1\n   line2\n   ```\n\nAfter list paragraph.\n',
    );
  });

  it('崩壊終了フェンス跡が後続の別リストの崩壊フェンスを巻き込み、その閉じ行が独立コードブロックの終了フェンスに見える場合、誤って中身をMarkdownとして再解釈しない', async () => {
    const input =
      '1. text\n   ```js\nline1\n   ```\n\n2. more\n   ```ts\nline2\n   ```\n';
    // 1番目のリストの崩壊終了フェンス跡は、後続の2番目のリスト全体を
    // 巻き込む（value非空）。巻き込んだ内容の最後の行（2番目のリストの
    // 本当の閉じフェンス）が、たまたま有効な終了フェンス行に見えるため、
    // hasOwnClosingFenceLineが「独立した正常なコードブロック」と判定し
    // 崩壊シグネチャの終了ノードとして扱わない（fail-closed）。1番目の
    // リストの崩壊は修復されないままになるが（既知の制約）、"line1"・
    // "2. more"・"line2"のいずれのテキストも失われず、Markdown構文
    // として誤って再解釈もされない（内容に```を含むためstringifyが
    // 自動的に4連続バッククォートのフェンスで囲む）。
    const output = await transformEnhancedMarkdown(input);
    // 仕様の核心（テキスト内容が失われないこと）をstringifyのフォーマット
    // 副産物とは独立に固定する。
    expect(output).toContain('line1');
    expect(output).toContain('2. more');
    expect(output).toContain('line2');
    expect(output).toBe(
      '1. text\n   ```js\n   ```\n\nline1\n\n````\n\n2. more\n```ts\nline2\n````\n',
    );
  });

  it('隣接する2つの崩壊リストがフェンス文字種違いで連続する場合、両方とも再帰的に修復される', async () => {
    const input =
      '1. text\n   ```js\nline1\n   ```\n\n2. more\n   ~~~ts\nline2\n   ~~~\n';
    // 1番目は```、2番目は~~~を使うため、1番目の崩壊終了フェンス跡の
    // 巻き込み範囲の最後の行（2番目の閉じフェンス~~~）はhasOwnClosingFenceLine
    // の文字種チェック（marker[0] === ownOpeningMarker.char）で一致せず、
    // 独立した正常なコードブロックとは判定されない。1番目の崩壊は正しく
    // 修復され、差し戻したtrailingがrepairBrokenCodeFencesへ再帰的に渡され、
    // 2番目の崩壊（```とは異なるフェンス文字種）も正しく修復される。
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```js\n   line1\n   ```\n\n2) more\n   ```ts\n   line2\n   ```\n',
    );
  });

  it('巻き込んだ後続本文の末尾に閉じフェンス行が現れない場合、1番目の崩壊は修復され後続内容は失われない', async () => {
    const input =
      '1. text\n   ```js\nline1\n   ```\n\n2. more\n   ```ts\nline2\n\nAfter.\n';
    // 1番目のリストの崩壊終了フェンス跡が巻き込む範囲（2番目のリストの
    // 崩壊開始・本文・後続段落）に、閉じフェンスに見える行が一つも
    // 現れないため、hasOwnClosingFenceLineはfalseを返し、1番目の崩壊は
    // 正しく修復される。差し戻したtrailingはrepairBrokenCodeFencesへ
    // 再帰的に渡されるが、2番目のリストは閉じフェンスがないため崩壊
    // シグネチャが揃わず変換されない（"2. more"・"line2"・"After."の
    // いずれも失われない）。
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('more');
    expect(output).toContain('line2');
    expect(output).toContain('After.');
    expect(output).toBe(
      '1. text\n   ```js\n   line1\n   ```\n\n2) more\n   ```ts\n   ```\n\nline2\n\nAfter.\n',
    );
  });

  it('リスト項目番号が2桁になりインデント幅が4スペース以上でも崩壊したコードフェンスが復元される', async () => {
    const items = Array.from(
      { length: 9 },
      (_, i) => `${i + 1}. item${i + 1}`,
    ).join('\n');
    const input = `${items}\n10. text\n    \`\`\`js\nconsole.log(1);\n\`\`\`\n`;
    const expected = `${items}\n10. text\n    \`\`\`js\n    console.log(1);\n    \`\`\`\n`;
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(expected);
  });

  it('崩壊開始の直後に続くインデントコードブロックを閉じフェンス跡と誤認せず内容を保持する', async () => {
    const input = '1. text\n   ```js\nline1\n\n    separate\n    code\n';
    // 崩壊シグネチャが揃わないため変換せず元のASTのままstringifyする
    // （安全側フォールバック）。開始フェンスは独立した空コードブロックとして
    // 出力される形になるが、"line1"・"separate"・"code"のいずれも失われない。
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```js\n   ```\n\nline1\n\n```\nseparate\ncode\n```\n',
    );
  });

  it('崩壊開始の直後に完結した別のコードフェンスが続く場合、そのコード内容を誤ってMarkdownとして変換しない', async () => {
    const input =
      '1. text\n   ```js\nline1\n\n```\n**not bold** # not heading\n```\n';
    // 独立した完結コードブロックの終了フェンスを崩壊シグネチャの終了候補
    // として誤認識すると、その中身が生Markdown文字列として再parseされ、
    // コード内容（**not bold**等）が通常のMarkdown構文として変換されて
    // しまう（AGENTS.mdの安全不変条件「code内を変更しない」に抵触）。
    // 崩壊シグネチャとして扱わず変換をスキップする（安全側フォールバック。
    // 崩壊開始ノードが独立した空コードブロックとして出力される形式上の
    // 変化はあるが、コード内容は生のまま保持されstrongノード等へ変換
    // されない）。
    const output = await transformEnhancedMarkdown(input);
    // 仕様の核心（**not bold**がMarkdown構文として再解釈されずstrong
    // ノード等へ変換されないこと）を、remark-stringifyのフォーマット
    // 副産物とは独立に固定する。
    expect(output).toContain('**not bold** # not heading');
    expect(output).toBe(
      '1. text\n   ```js\n   ```\n\nline1\n\n```\n**not bold** # not heading\n```\n',
    );
  });

  it('崩壊開始の直後にインデントコードブロックが続き、その内容がフェンス記号で始まる場合でも内容を保持する', async () => {
    const input = '1. text\n   ```js\nline1\n\n    ```\n    secret\n';
    // 終了候補が4スペースインデントのコードブロック（フェンスでない）で
    // あり、その内容の1行目がたまたま```で始まる場合でも、終了候補として
    // 誤認識せず、著者が書いた```という文字列自体を失わない（stringifyは
    // 内容に```を含むため自動的に4連続バッククォートのフェンスで囲む）。
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('```\nsecret');
    expect(output).toBe(
      '1. text\n   ```js\n   ```\n\nline1\n\n````\n```\nsecret\n````\n',
    );
  });

  it('本文に著者が元から書いたU+200Bは削除されずそのまま保持される', async () => {
    const zwsp = String.fromCharCode(0x200b);
    const input = `before${zwsp}after`;
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      `before${zwsp}after\n`,
    );
  });

  it('著者記述のU+200Bと太字修復で挿入されたU+200Bが混在しても、挿入分だけが除去される', async () => {
    const zwsp = String.fromCharCode(0x200b);
    const input = `前${zwsp}後 限り**、実行時に変更する**ことができる`;
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      `前${zwsp}後 限り**、実行時に変更する**ことができる\n`,
    );
  });

  it('U+200Bを含まない本文中の私用領域文字（sentinelと同じ文字）は書き換えられない', async () => {
    const privateUseChar = String.fromCharCode(0xe000);
    const input = `before${privateUseChar}after`;
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      `before${privateUseChar}after\n`,
    );
  });

  it('U+200Bと既定sentinel（U+E000）が同時に含まれる場合でも、別の私用領域文字へ退避し両方保持する', async () => {
    const zwsp = String.fromCharCode(0x200b);
    const defaultSentinel = String.fromCharCode(0xe000);
    const input = `before${zwsp}middle${defaultSentinel}after`;
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      `before${zwsp}middle${defaultSentinel}after\n`,
    );
  });

  it('タブでインデントされた開始フェンス行を持つ崩壊コードフェンスが正しく復元される', async () => {
    const input = '1. text\n\t```js\nconsole.log(1);\n```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```js\n   console.log(1);\n   ```\n',
    );
  });

  it('タブとスペースが混在するインデントの開始フェンス行でも崩壊コードフェンスが復元される', async () => {
    const input = '1. text\n \t```js\nconsole.log(1);\n```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```js\n   console.log(1);\n   ```\n',
    );
  });

  it('終了候補行がタブ1つ（4スペース相当）でインデントされている場合、実効幅が0〜3を超えるため終了候補として誤って許容されない', async () => {
    const input = '1. text\n   ```js\nline1\n\n\t```\n';
    const output = await transformEnhancedMarkdown(input);
    // 終了候補が誤って許容されると崩壊シグネチャとして修復されてしまうが、
    // タブ1つ=実効幅4はmaxIndent:3を超えるため終了候補として扱われず、
    // 安全側フォールバック（未修復のまま）になる。テキスト内容自体は
    // 失われない。
    expect(output).toContain('line1');
    expect(output).toBe(
      '1. text\n   ```js\n   ```\n\nline1\n\n````\n```\n````\n',
    );
  });

  it('空行を挟んで開始タグ・終了タグが別ノードに分裂した callout が正しく変換される', async () => {
    const input =
      '例)text\n<callout icon="💡" color="gray_bg">\nbody line1\nbody line2\n\n</callout>\n次の段落\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '例)text\n\n> [!note]\n> body line1\n> body line2\n\n次の段落\n',
    );
  });

  it('分裂したcalloutの終了ノードが後続本文を巻き込む場合、その本文が失われず独立したブロックとして復元される', async () => {
    const input =
      '例)text\n<callout icon="💡" color="gray_bg">\nbody\n\n</callout>\nDuckもインターフェイスにすべき？\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '例)text\n\n> [!note]\n> body\n\nDuckもインターフェイスにすべき？\n',
    );
  });

  it('開始callout段落にtext以外の型が混ざる場合は結合せず元のHTMLノードのまま出力する', async () => {
    const input = '例)text\n<callout icon="💡">\n**bold**\n\n</callout>\n次\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('<callout');
    expect(output).toContain('</callout>');
  });

  it('分裂したcalloutが巻き込んだ後続本文にさらにネストした崩壊コードフェンスがあっても、誤ったoffsetでsourceTextをスライスせず安全側フォールバックする', async () => {
    const input =
      '例)text\n<callout icon="💡">\nbody\n\n</callout>\n1. more\n\t```js\nconsole.log(1);\n```\n';
    const output = await transformEnhancedMarkdown(input);
    // trailing fragment内のネストした崩壊コードフェンスは、位置情報が
    // trailing文字列基準のまま元のsourceTextに対して誤ってスライスされる
    // ことがない（stripPositionsDeepでposition削除→offset未定義→安全側
    // フォールバック）。誤った内容に化けず、著者が書いた内容が失われない
    // ことを確認する。
    expect(output).toContain('console.log(1);');
    expect(output).toContain('> [!note]');
    expect(output).toContain('> body');
  });

  it('分裂したcalloutが巻き込んだ後続本文内の崩壊コードフェンスが正しく修復される', async () => {
    const input =
      '例)text\n<callout icon="💡">\nbody\n\n</callout>\n1. text\n   ```javascript\nconsole.log(1);\nconsole.log(2);\n   ```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '例)text\n\n> [!note]\n> body\n\n1. text\n   ```javascript\n   console.log(1);\n   console.log(2);\n   ```\n',
    );
  });

  it('開始calloutの直後の兄弟がhtml型でない場合は結合せず元のHTMLノードのまま出力する', async () => {
    const input =
      '例)text\n<callout icon="💡">\nbody\n\nnot html node\n\n</callout>\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('<callout');
  });

  it('リスト境界をまたぐcallout分裂（開始タグがリスト最後の項目内にネストし終了タグがリスト直後の兄弟に出現する場合）が正しく結合される', async () => {
    const input =
      '- item one\n- item two\n  <callout icon="💡">\n  本文\n</callout>\n続きのテキスト\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '- item one\n- item two\n  > [!note]\n  > 本文\n\n続きのテキスト\n',
    );
  });

  it('リスト境界をまたぐcallout分裂が巻き込んだ後続本文内の崩壊コードフェンスが正しく修復される', async () => {
    const input =
      '- item one\n  <callout icon="💡">\n  本文\n</callout>\n1. text\n   ```javascript\nconsole.log(1);\nconsole.log(2);\n   ```\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('> [!note]');
    expect(output).toContain('> 本文');
    expect(output).toContain('console.log(1);');
    expect(output).toContain('console.log(2);');
    expect(output).not.toContain('\\`\\`\\`');
  });

  it('タブ開始・終了インデント、plain textのinfo string、終了フェンスがparagraph途中に吸収、直後に空行なしの本文、続いて見出しという実データ相当のケースが正しく修復される', async () => {
    const input =
      '1. text\n\t1. nested\n2. more\n\t```plain text\npublic abstract class Duck{\n  // **not bold** `inline code` <b>html</b>\n}\n\t```\nafter fence with **bold** and `code` and [link](http://example.com).\n## Next heading\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   1. nested\n2. more\n   ```plain text\n   public abstract class Duck{\n     // **not bold** `inline code` <b>html</b>\n   }\n   ```\n\nafter fence with **bold** and `code` and [link](http://example.com).\n\n## Next heading\n',
    );
  });

  it('終了候補がparagraph最終行にある従来ケース（後続本文なし）も引き続き成功する', async () => {
    const input =
      '1. text\n\t1. nested\n2. more\n\t```plain text\npublic abstract class Duck{\n}\n\t```\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   1. nested\n2. more\n   ```plain text\n   public abstract class Duck{\n   }\n   ```\n',
    );
  });

  it('marker長不足（終了側のマーカー長が開始側未満）は修復しない', async () => {
    const input = '1. text\n\t````plain text\nline1\n\t```\nafter\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```plain text\n   ```\n\nline1\n\\`\\`\\`\nafter\n',
    );
  });

  it('indentation実効幅不一致（開始タブ4幅・終了スペース+タブ5幅）は修復しない', async () => {
    const input = '1. text\n\t```plain text\nline1\n \t```\nafter\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```plain text\n   ```\n\nline1\n\\`\\`\\`\nafter\n',
    );
  });

  it('indentation実効幅が一致すればraw文字列（タブ・スペース構成）が異なっても修復される（開始タブ4幅・終了スペース4幅）', async () => {
    const input =
      '1. text\n\t```plain text\npublic abstract class Duck{\n}\n    ```\nafter fence text.\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('```plain text');
    expect(output).toContain('public abstract class Duck{');
    expect(output).toContain('after fence text.');
    expect(output).not.toContain('\\`\\`\\`');
  });

  it('paragraph内に終了フェンス候補が複数見つかる場合はどれが本当の終端か判別できず修復しない', async () => {
    const input = '1. text\n\t```plain text\nline1\n\t```\nmid\n\t```\nafter\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```plain text\n   ```\n\nline1\n`\nmid\n\t`\nafter\n',
    );
  });

  it('marker行に後方本文が同一行で混在する場合（行全体がフェンスのみでない）は修復しない', async () => {
    const input =
      '1. text\n\t```plain text\nline1\n\t``` trailing text\nafter\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '1. text\n   ```plain text\n   ```\n\nline1\n\\`\\`\\` trailing text\nafter\n',
    );
  });

  it('崩壊開始シグネチャ（ordered listの末尾がlang付き空code）がない通常paragraphは変更しない', async () => {
    const input = '普通の段落。\n\t```\nこれは崩壊開始ではない。\n';
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      '普通の段落。\n\\`\\`\\`\nこれは崩壊開始ではない。\n',
    );
  });

  it('CRLFの崩壊コードフェンスでも本文・後続本文を失わない', async () => {
    const input =
      '1. text\r\n\t```plain text\r\npublic class X{\r\n  int a;\r\n}\r\n\t```\r\nafter fence text.\r\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('public class X{');
    expect(output).toContain('int a;');
    expect(output).toContain('after fence text.');
  });

  it('崩壊code本文内の既知underscoreタグ（synced_block/table_of_contents）はpre-parse正規化でリネームされない', async () => {
    const input =
      '1. text\n\t```plain text\n<synced_block>\n<table_of_contents/>\n\t```\nafter\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('<synced_block>');
    expect(output).toContain('<table_of_contents/>');
    expect(output).not.toContain('<synced-block>');
    expect(output).not.toContain('<table-of-contents/>');
  });

  it('崩壊code本文内に元からハイフン表記の文字列があっても逆変換されずそのまま保持される', async () => {
    const input =
      '1. text\n\t```plain text\nline before\n<synced-block>\n<table-of-contents/>\n\t```\nafter\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('<synced-block>');
    expect(output).toContain('<table-of-contents/>');
  });

  it('崩壊code本文内の太字flanking補正対象文字列がU+200B挿入されず元入力の文字列のまま保持される', async () => {
    const input =
      '1. text\n\t```plain text\n限り**、実行時に変更する**こと\n\t```\nafter\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('限り**、実行時に変更する**こと');
  });

  it('崩壊codeより前の通常本文にflanking補正がありoffsetがずれても崩壊code本文の境界が正しく特定される', async () => {
    const input =
      '限り**、直前の補正**あり\n\n1. text\n\t```plain text\npublic class X{}\n\t```\nafter\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('public class X{}');
  });

  it('崩壊codeより前に複数の太字flanking補正挿入箇所があっても累積offsetのずれを正しく吸収する', async () => {
    const input =
      '限り**、1つ目**あり 限り**、2つ目**あり\n\n1. a\n\t```plain text\npublic class A{}\n\t```\nmid\n\n1. b\n\t```plain text\npublic class B{}\n\t```\nafter\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('public class A{}');
    expect(output).toContain('public class B{}');
  });

  it('同一文書に複数の崩壊code rangeがあっても両方とも正しく修復される', async () => {
    const input =
      '1. text\n\t```plain text\npublic class A{}\n\t```\nmiddle\n\n1. text2\n\t```plain text\npublic class B{}\n\t```\nafter\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('public class A{}');
    expect(output).toContain('public class B{}');
    expect(output).toContain('middle');
    expect(output).toContain('after');
  });

  it('U+200BとU+E000〜U+E00Fの全16sentinel候補を同時に含む場合、全候補衝突によりsentinel退避を諦めても著者記述のU+200Bと全候補文字が失われず保持される', async () => {
    const zwsp = String.fromCharCode(0x200b);
    const allSentinels = Array.from({ length: 16 }, (_, i) =>
      String.fromCharCode(0xe000 + i),
    ).join('');
    const input = `before${zwsp}${allSentinels}after`;
    await expect(transformEnhancedMarkdown(input)).resolves.toBe(
      `before${zwsp}${allSentinels}after\n`,
    );
  });

  it('synced_block内に崩壊コードフェンスがあっても、fragment化された別sourceText基準のため修復されないが文字列は失われず、code内容がstrong等として誤って再解釈されない', async () => {
    const input =
      '<synced_block url="x">\n1. text\n\t```plain text\npublic class X{ **not real bold** }\n\t```\nafter\n</synced_block>\n';
    const output = await transformEnhancedMarkdown(input);
    expect(output).toContain('public class X{');
    expect(output).toContain('**not real bold**');
    expect(output).toContain('after');
  });
});
