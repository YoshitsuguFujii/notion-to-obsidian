import { describe, expect, it, vi } from 'vitest';
import type { NotionClient } from '../src/notion/types.js';
import { retrievePageMarkdown } from '../src/notion/markdown.js';

function client(
  retrieveMarkdown: NotionClient['retrieveMarkdown'],
): NotionClient {
  return {
    retrieveMarkdown,
    retrievePage: vi.fn(),
    retrieveDatabase: vi.fn(),
    listBlockChildren: vi.fn(),
    queryDataSource: vi.fn(),
    search: vi.fn(),
  };
}

function response(
  id: string,
  markdown: string,
  unknownBlockIds: string[] = [],
  truncated = false,
) {
  return {
    object: 'page_markdown',
    id,
    markdown,
    truncated,
    unknown_block_ids: unknownBlockIds,
  };
}

describe('retrievePageMarkdown', () => {
  it('完全な Markdown API 応答をそのまま返す', async () => {
    const notion = client(
      vi.fn().mockResolvedValue(response('page', '# Title')),
    );

    await expect(retrievePageMarkdown(notion, 'page')).resolves.toEqual({
      markdown: '# Title',
      needsBlockFallback: false,
      warnings: [],
      sidecars: [],
    });
  });

  it('unknown の数と ID 数が一致する場合だけ出現順に追加取得結果をマージする', async () => {
    const retrieveMarkdown = vi.fn((id: string) => {
      if (id === 'page')
        return Promise.resolve(
          response('page', 'Before\n<unknown>\nMiddle\n<unknown>\nAfter', [
            'block-a',
            'block-b',
          ]),
        );
      return Promise.resolve(response(id, id === 'block-a' ? 'Alpha' : 'Beta'));
    });

    const result = await retrievePageMarkdown(client(retrieveMarkdown), 'page');

    expect(result.markdown).toBe('Before\nAlpha\nMiddle\nBeta\nAfter');
    expect(result.needsBlockFallback).toBe(false);
    expect(retrieveMarkdown.mock.calls.map(([id]) => id)).toEqual([
      'page',
      'block-a',
      'block-b',
    ]);
  });

  it('unknown の位置を一意に対応付けられない場合は元本文を維持して fallback を要求する', async () => {
    const notion = client(
      vi
        .fn()
        .mockResolvedValue(
          response('page', 'Only <unknown>', ['block-a', 'block-b']),
        ),
    );

    const result = await retrievePageMarkdown(notion, 'page');

    expect(result.markdown).toBe('Only <unknown>');
    expect(result.needsBlockFallback).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'ambiguous_unknown_positions' }),
    );
  });

  it('unknown block の404を削除扱いせず placeholder warning sidecar として保持する', async () => {
    const retrieveMarkdown = vi.fn((id: string) => {
      if (id === 'page')
        return Promise.resolve(
          response('page', '<unknown>', ['missing-block']),
        );
      return Promise.reject(
        Object.assign(new Error('not found'), { status: 404 }),
      );
    });

    const result = await retrievePageMarkdown(client(retrieveMarkdown), 'page');

    expect(result.needsBlockFallback).toBe(false);
    expect(result.markdown).toContain(
      '<!-- notion-to-obsidian: unsupported block type=unavailable id=missing-block -->',
    );
    expect(result.warnings).toContainEqual({
      type: 'block_unavailable',
      blockId: 'missing-block',
      message: 'Unknown block could not be retrieved',
    });
    expect(result.sidecars).toContainEqual(
      expect.objectContaining({ type: 'unavailable', id: 'missing-block' }),
    );
  });

  it('truncated 応答を完全な本文として扱わず fallback を要求する', async () => {
    const notion = client(
      vi.fn().mockResolvedValue(response('page', 'Partial body', [], true)),
    );

    const result = await retrievePageMarkdown(notion, 'page');

    expect(result.needsBlockFallback).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'truncated' }),
    );
  });

  it('code 内の unknown 文字列を placeholder として数えず変更しない', async () => {
    const retrieveMarkdown = vi.fn((id: string) =>
      Promise.resolve(
        id === 'page'
          ? response('page', '```text\n<unknown>\n```\n\nReal: <unknown>', [
              'block-a',
            ])
          : response('block-a', 'Resolved'),
      ),
    );

    const result = await retrievePageMarkdown(client(retrieveMarkdown), 'page');

    expect(result.needsBlockFallback).toBe(false);
    expect(result.markdown).toBe('```text\n<unknown>\n```\n\nReal: Resolved');
  });

  it.each([
    '<unknown>',
    '<unknown url="https://example.com/file.pdf" alt="file"/>',
    '<unknown url="https://example.com/file.pdf">',
  ])('%s を unknown block として置換する', async (unknownToken) => {
    const retrieveMarkdown = vi.fn((id: string) =>
      Promise.resolve(
        id === 'page'
          ? response('page', `Before\n${unknownToken}\nAfter`, ['block-a'])
          : response('block-a', 'Resolved'),
      ),
    );

    const result = await retrievePageMarkdown(client(retrieveMarkdown), 'page');

    expect(result.needsBlockFallback).toBe(false);
    expect(result.markdown).toBe('Before\nResolved\nAfter');
  });

  it('<unknownfoo> を unknown block と誤認しない', async () => {
    const retrieveMarkdown = vi.fn((id: string) =>
      Promise.resolve(
        id === 'page'
          ? response('page', '<unknownfoo>\n\n<unknown url="asset"/>', [
              'block-a',
            ])
          : response('block-a', 'Resolved'),
      ),
    );

    const result = await retrievePageMarkdown(client(retrieveMarkdown), 'page');

    expect(result.needsBlockFallback).toBe(false);
    expect(result.markdown).toBe('<unknownfoo>\n\nResolved');
  });
});
