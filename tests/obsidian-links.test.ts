import { describe, expect, it } from 'vitest';
import {
  extractNotionIdFromPathSegment,
  normalizeNotionId,
} from '../src/notion-id.js';
import {
  buildIdToPathMap,
  extractNotionPageId,
  resolveInternalLinks,
} from '../src/transform/obsidian-links.js';

describe('Notion page identity', () => {
  it.each([
    [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
    ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('ID %s を比較用32桁hexへ正規化する', (input, expected) => {
    expect(normalizeNotionId(input)).toBe(expected);
  });

  it.each([
    'not-an-id',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa',
    'gggggggggggggggggggggggggggggggg',
  ])('不正なID %sを拒否する', (input) => {
    expect(normalizeNotionId(input)).toBeUndefined();
  });

  it.each([
    [
      'Project-Notes-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
    [
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'cccccccccccccccccccccccccccccccc',
    ],
  ])('path segment %s の末尾から比較用IDを抽出する', (input, expected) => {
    expect(extractNotionIdFromPathSegment(input)).toBe(expected);
  });

  it('有効なIDで終わらないpath segmentを拒否する', () => {
    expect(
      extractNotionIdFromPathSegment('Project-Notes-not-an-id'),
    ).toBeUndefined();
  });

  it.each([
    [
      'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
    [
      'https://www.notion.so/Project-Notes-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?source=copy_link',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ],
    [
      'https://notion.so/cccccccc-cccc-cccc-cccc-cccccccccccc',
      'cccccccccccccccccccccccccccccccc',
    ],
  ])('Notion URL %s の末尾からIDを抽出する', (url, expected) => {
    expect(extractNotionPageId(url)).toBe(expected);
  });

  it.each([
    'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://www.notion.so.evil.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'ftp://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://www.notion.so/not-a-page',
    'not a url',
  ])('対象外URL %sからIDを抽出しない', (url) => {
    expect(extractNotionPageId(url)).toBeUndefined();
  });
});

describe('buildIdToPathMap', () => {
  it('path plan の安定IDと期待パスを対応付ける', () => {
    const map = buildIdToPathMap([
      {
        notionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        expectedPath: '開発/Rails.md',
        resolvedFilename: 'Rails',
      },
    ]);

    expect(map).toEqual(
      new Map([['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '開発/Rails.md']]),
    );
  });
});

describe('resolveInternalLinks', () => {
  it('Markdown link と mention を .md 無しの POSIX WikiLink へ変換する', async () => {
    const paths = new Map([
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Parent\\Page.md'],
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Mentioned.md'],
    ]);
    const markdown =
      '[Page](https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) and ' +
      '<mention-page url="https://www.notion.so/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb">Mention</mention-page>.';

    await expect(resolveInternalLinks(markdown, paths)).resolves.toBe(
      '[[Parent/Page|Page]] and [[Mentioned|Mention]].\n',
    );
  });

  it('対象外 Notion link、外部 link、code と inline code を変更しない', async () => {
    const markdown = [
      '[Outside](https://www.notion.so/cccccccccccccccccccccccccccccccc)',
      '',
      '[External](https://example.com/page)',
      '',
      '`https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`',
      '',
      '```text',
      'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '```',
    ].join('\n');

    const result = await resolveInternalLinks(
      markdown,
      new Map([['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Internal.md']]),
    );

    expect(result).toContain(
      '[Outside](https://www.notion.so/cccccccccccccccccccccccccccccccc)',
    );
    expect(result).toContain('[External](https://example.com/page)');
    expect(result).toContain(
      '`https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`',
    );
    expect(result).toContain(
      '```text\nhttps://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n```',
    );
    expect(result).not.toContain('[[Internal');
  });

  it('<page> タグのDB row pageをIDで解決する', async () => {
    const markdown =
      '<page url="https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Related row</page>';

    await expect(
      resolveInternalLinks(
        markdown,
        new Map([['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Database/Row.md']]),
      ),
    ).resolves.toBe('[[Database/Row|Related row]]\n');
  });
});
