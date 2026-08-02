import { describe, expect, it, vi } from 'vitest';
import type { NotionClient } from '../src/notion/types.js';
import { retrieveBlockTree } from '../src/notion/blocks.js';
import { renderFallbackBlocks } from '../src/transform/fallback-block-renderer.js';
import { retrieveMarkdownWithFallback } from '../src/notion/markdown.js';

const richText = (content: string) => [
  {
    type: 'text',
    plain_text: content,
    text: { content },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      code: false,
    },
  },
];

const block = (
  id: string,
  type: string,
  value: Record<string, unknown>,
  hasChildren = false,
) => ({ id, type, [type]: value, has_children: hasChildren });

function notion(
  listBlockChildren: NotionClient['listBlockChildren'],
): NotionClient {
  return {
    listBlockChildren,
    retrieveMarkdown: vi.fn(),
    retrievePage: vi.fn(),
    retrieveDatabase: vi.fn(),
    queryDataSource: vi.fn(),
    search: vi.fn(),
  };
}

describe('Block API fallback', () => {
  it('全 cursor と子 block を取得して基本 block を Markdown 化する', async () => {
    const listBlockChildren = vi.fn((id: string, cursor?: string) => {
      if (id === 'page' && cursor === undefined)
        return Promise.resolve({
          results: [
            block('p', 'paragraph', { rich_text: richText('Paragraph') }),
            block('h', 'heading_1', { rich_text: richText('Heading') }),
            block('h2', 'heading_2', { rich_text: richText('Heading two') }),
            block('h3', 'heading_3', { rich_text: richText('Heading three') }),
            block(
              'bullet',
              'bulleted_list_item',
              { rich_text: richText('Item') },
              true,
            ),
          ],
          has_more: true,
          next_cursor: 'next',
        });
      if (id === 'page')
        return Promise.resolve({
          results: [
            block('todo', 'to_do', {
              rich_text: richText('Task'),
              checked: true,
            }),
            block('number', 'numbered_list_item', {
              rich_text: richText('Numbered'),
            }),
            block('quote', 'quote', { rich_text: richText('Quote') }),
            block('divider', 'divider', {}),
            block('code', 'code', {
              rich_text: richText('const x = 1;'),
              language: 'typescript',
            }),
            block('image', 'image', {
              type: 'external',
              external: { url: 'https://example.com/a.png' },
              caption: richText('Alt'),
            }),
            block('file', 'file', {
              type: 'external',
              external: { url: 'https://example.com/a.pdf' },
              name: 'Document',
            }),
            block('unknown', 'mystery', { value: 1 }),
          ],
          has_more: false,
          next_cursor: null,
        });
      return Promise.resolve({
        results: [
          block('nested', 'paragraph', { rich_text: richText('Nested') }),
        ],
        has_more: false,
        next_cursor: null,
      });
    });

    const tree = await retrieveBlockTree(notion(listBlockChildren), 'page');
    const result = renderFallbackBlocks(tree);

    expect(result.markdown).toContain('# Heading');
    expect(result.markdown).toContain('## Heading two');
    expect(result.markdown).toContain('### Heading three');
    expect(result.markdown).toContain('- Item\n  Nested');
    expect(result.markdown).toContain('- [x] Task');
    expect(result.markdown).toContain('1. Numbered');
    expect(result.markdown).toContain('> Quote');
    expect(result.markdown).toContain('```typescript\nconst x = 1;\n```');
    expect(result.markdown).toContain('![Alt](https://example.com/a.png)');
    expect(result.markdown).toContain('[Document](https://example.com/a.pdf)');
    expect(result.markdown).toContain(
      '<!-- notion-to-obsidian: unsupported block type=mystery id=unknown -->',
    );
    expect(result.sidecars).toContainEqual(
      expect.objectContaining({ type: 'mystery', id: 'unknown' }),
    );
    expect(listBlockChildren).toHaveBeenCalledWith('page', 'next');
    expect(listBlockChildren).toHaveBeenCalledWith('bullet', undefined);
  });

  it('Markdown API の位置が曖昧な場合にページ全体を Block API で描画する', async () => {
    const client = notion(
      vi.fn().mockResolvedValue({
        results: [
          block('p', 'paragraph', { rich_text: richText('Fallback body') }),
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    client.retrieveMarkdown = vi.fn().mockResolvedValue({
      object: 'page_markdown',
      id: 'page',
      markdown: '<unknown>',
      truncated: false,
      unknown_block_ids: ['a', 'b'],
    });

    const result = await retrieveMarkdownWithFallback(client, 'page');

    expect(result.source).toBe('block');
    expect(result.markdown).toBe('Fallback body');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'ambiguous_unknown_positions' }),
    );
  });

  it('has_column_header: true の table ブロックを、先頭行をヘッダーとした Markdown テーブルへ変換する', () => {
    const tableNode = {
      block: block(
        'table1',
        'table',
        { has_column_header: true, table_width: 2 },
        true,
      ),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Name'), richText('Score')],
          }),
          children: [],
        },
        {
          block: block('row2', 'table_row', {
            cells: [richText('Alice'), richText('90')],
          }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toBe(
      '| Name | Score |\n| --- | --- |\n| Alice | 90 |',
    );
  });

  it('has_column_header: false の table ブロックは、空のヘッダー行を合成した Markdown テーブルへ変換する', () => {
    const tableNode = {
      block: block(
        'table1',
        'table',
        { has_column_header: false, table_width: 2 },
        true,
      ),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Alice'), richText('90')],
          }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toBe('|  |  |\n| --- | --- |\n| Alice | 90 |');
  });

  it('セル内の改行（shift+enter）を <br> へ変換し行を壊さない', () => {
    const tableNode = {
      block: block(
        'table1',
        'table',
        { has_column_header: true, table_width: 2 },
        true,
      ),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Name'), richText('Note')],
          }),
          children: [],
        },
        {
          block: block('row2', 'table_row', {
            cells: [richText('Alice'), richText('Line one\nLine two')],
          }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toBe(
      '| Name | Note |\n| --- | --- |\n| Alice | Line one<br>Line two |',
    );
  });

  it('列数が行間で不一致な table ブロックは変換せず unsupported として保全する', () => {
    const tableNode = {
      block: block(
        'table1',
        'table',
        { has_column_header: true, table_width: 2 },
        true,
      ),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Name'), richText('Score')],
          }),
          children: [],
        },
        {
          block: block('row2', 'table_row', { cells: [richText('Alice')] }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toContain('[Unsupported block: table]');
    const sidecar = result.sidecars.find(
      (entry) => entry.type === 'table' && entry.id === 'table1',
    );
    expect(sidecar).toBeDefined();
    const payload = sidecar?.payload as { rows: Array<{ id: string }> };
    expect(payload.rows.map((row) => row.id)).toEqual(['row1', 'row2']);
  });

  it('table_width と行内のセル数が食い違う table ブロックは、行同士が一致していても変換せず unsupported として保全する', () => {
    const tableNode = {
      block: block(
        'table1',
        'table',
        { has_column_header: true, table_width: 3 },
        true,
      ),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Name'), richText('Score')],
          }),
          children: [],
        },
        {
          block: block('row2', 'table_row', {
            cells: [richText('Alice'), richText('90')],
          }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toContain('[Unsupported block: table]');
    const sidecar = result.sidecars.find(
      (entry) => entry.type === 'table' && entry.id === 'table1',
    );
    expect(sidecar).toBeDefined();
  });

  it('table_width が欠落した table ブロックは変換せず unsupported として保全する', () => {
    const tableNode = {
      block: block('table1', 'table', { has_column_header: true }, true),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Alice'), richText('90')],
          }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toContain('[Unsupported block: table]');
  });

  it.each([0, -1, 1.5, '2'])(
    'table_width が不正な値（%s）の table ブロックは変換せず unsupported として保全する',
    (tableWidth) => {
      const tableNode = {
        block: block(
          'table1',
          'table',
          { has_column_header: true, table_width: tableWidth },
          true,
        ),
        children: [
          {
            block: block('row1', 'table_row', {
              cells: [richText('Alice'), richText('90')],
            }),
            children: [],
          },
        ],
      };

      const result = renderFallbackBlocks([tableNode]);

      expect(result.markdown).toContain('[Unsupported block: table]');
    },
  );

  it('table_row 以外の子が混在する table ブロックは変換せず unsupported として保全する', () => {
    const tableNode = {
      block: block(
        'table1',
        'table',
        { has_column_header: true, table_width: 2 },
        true,
      ),
      children: [
        {
          block: block('row1', 'table_row', {
            cells: [richText('Name'), richText('Score')],
          }),
          children: [],
        },
        {
          block: block('note1', 'paragraph', {
            rich_text: richText('unexpected sibling'),
          }),
          children: [],
        },
      ],
    };

    const result = renderFallbackBlocks([tableNode]);

    expect(result.markdown).toContain('[Unsupported block: table]');
  });
});
