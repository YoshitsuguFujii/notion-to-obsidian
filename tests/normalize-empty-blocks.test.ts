import { describe, expect, it } from 'vitest';
import { normalizeEmptyBlocks } from '../src/transform/normalize-empty-blocks.js';

describe('normalizeEmptyBlocks', () => {
  it('単独の空ブロックを空行へ変換して前後の段落を分離する', () => {
    expect(normalizeEmptyBlocks('before\n<empty-block/>\nafter')).toBe(
      'before\n\nafter',
    );
  });

  it.each([
    ['4空白', '    <empty-block/>'],
    ['タブ', '\t<empty-block/>'],
    ['リスト内', '- item\n  <empty-block/>'],
  ])('先頭が%sで字下げされた空ブロックは変更しない', (_case, input) => {
    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it.each([
    [
      'backtick',
      [
        '```',
        '~~~',
        '<empty-block/>',
        '~~~',
        '```',
        'before',
        '<empty-block/>',
        'after',
      ].join('\n'),
      [
        '```',
        '~~~',
        '<empty-block/>',
        '~~~',
        '```',
        'before',
        '',
        'after',
      ].join('\n'),
    ],
    [
      'tilde',
      [
        '~~~',
        '```',
        '<empty-block/>',
        '```',
        '~~~',
        'before',
        '<empty-block/>',
        'after',
      ].join('\n'),
      [
        '~~~',
        '```',
        '<empty-block/>',
        '```',
        '~~~',
        'before',
        '',
        'after',
      ].join('\n'),
    ],
  ])(
    '%sフェンスは反対種類のフェンス風の行では閉じない',
    (_case, input, expected) => {
      expect(normalizeEmptyBlocks(input)).toBe(expected);
    },
  );

  it('開始より短い行や末尾に内容がある行では閉じず同長以上で末尾が水平空白の行で閉じる', () => {
    const input = [
      '````',
      '```',
      '<empty-block/>',
      '```` not-a-closing-fence',
      '<empty-block/>',
      '````` \t',
      'before',
      '<empty-block/>',
      'after',
    ].join('\n');
    const expected = [
      '````',
      '```',
      '<empty-block/>',
      '```` not-a-closing-fence',
      '<empty-block/>',
      '````` \t',
      'before',
      '',
      'after',
    ].join('\n');

    expect(normalizeEmptyBlocks(input)).toBe(expected);
  });

  it.each([
    [
      '開始3空白・終了0空白',
      '   ```\n<empty-block/>\n```\nbefore\n<empty-block/>\nafter',
      '   ```\n<empty-block/>\n```\nbefore\n\nafter',
    ],
    [
      '開始0空白・終了3空白',
      '```\n<empty-block/>\n   ```\nbefore\n<empty-block/>\nafter',
      '```\n<empty-block/>\n   ```\nbefore\n\nafter',
    ],
  ])('%sでもフェンスを閉じる', (_case, input, expected) => {
    expect(normalizeEmptyBlocks(input)).toBe(expected);
  });

  it('フェンス内の情報文字列風の行と空ブロックを変更しない', () => {
    const input = [
      '```typescript',
      '```javascript',
      '<empty-block/>',
      '```',
    ].join('\n');

    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it('閉じていないフェンスの末尾まで空ブロックを変更しない', () => {
    const input = ['~~~typescript', '<empty-block/>'].join('\n');

    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it('backtickを含む情報文字列はbacktickフェンスを開始しない', () => {
    const input = '```language`option\nbefore\n<empty-block/>\nafter';

    expect(normalizeEmptyBlocks(input)).toBe(
      '```language`option\nbefore\n\nafter',
    );
  });

  it('backtickを含む情報文字列でもtildeフェンスを開始する', () => {
    const input = '~~~language`option\n<empty-block/>\n~~~';

    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it.each([
    ['0空白', '```\n<empty-block/>\n```'],
    ['3空白', '   ```\n<empty-block/>\n```'],
  ])('%sで始まるフェンス内は変更しない', (_case, input) => {
    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it('4空白で始まる行をフェンス開始とみなさない', () => {
    const input = '    ```\nbefore\n<empty-block/>\nafter';

    expect(normalizeEmptyBlocks(input)).toBe('    ```\nbefore\n\nafter');
  });

  it.each([
    ['文書先頭', '<empty-block/>\nafter', 'after'],
    ['文書末尾', 'before\n<empty-block/>', 'before'],
    ['末尾改行のある文書末尾', 'before\n<empty-block/>\n', 'before'],
    ['入力全体', '<empty-block/>', ''],
    ['末尾改行のある入力全体', '<empty-block/>\n', ''],
  ])('%sの空ブロックは不要な空行を残さない', (_case, input, expected) => {
    expect(normalizeEmptyBlocks(input)).toBe(expected);
  });

  it('連続する空ブロックと隣接する水平空白だけの行を1空行へ集約する', () => {
    const input = [
      'before',
      '<empty-block/>',
      '   ',
      '\t',
      '<empty-block/>\t',
      'after',
    ].join('\n');

    expect(normalizeEmptyBlocks(input)).toBe('before\n\nafter');
  });

  it('空ブロックを含まない水平空白だけの行を変更しない', () => {
    const input = 'before\n  \n\t\n\nafter';

    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it.each([
    ['空文字', ''],
    ['LFと末尾改行あり', 'before\n\nafter\n'],
    ['LFと末尾改行なし', 'before\n\nafter'],
    ['CRLFと末尾改行あり', 'before\r\n\r\nafter\r\n'],
    ['CRLFと末尾改行なし', 'before\r\n\r\nafter'],
  ])('対象がない%sの入力をbyte-for-byteで変更しない', (_case, input) => {
    expect(normalizeEmptyBlocks(input)).toBe(input);
  });

  it('CRLFの終了フェンスを認識してフェンス外だけを正規化する', () => {
    const input = [
      '```',
      '<empty-block/>',
      '```',
      'before',
      '<empty-block/>',
      'after',
    ].join('\r\n');
    const expected = [
      '```',
      '<empty-block/>',
      '```',
      'before',
      '',
      'after',
    ].join('\r\n');

    expect(normalizeEmptyBlocks(input)).toBe(expected);
  });

  it('複数回適用しても出力を変更しない', () => {
    const input =
      '<empty-block/>\nbefore\n<empty-block/>\n \n<empty-block/>\nafter\n<empty-block/>';
    const once = normalizeEmptyBlocks(input);

    expect(normalizeEmptyBlocks(once)).toBe(once);
  });
});
