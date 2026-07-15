import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createFrontmatter } from '../src/transform/frontmatter.js';

function parseFrontmatter(frontmatter: string): unknown {
  const lines = frontmatter.split('\n');
  expect(lines[0]).toBe('---');
  expect(lines.at(-2)).toBe('---');
  return parse(lines.slice(1, -2).join('\n'));
}

describe('createFrontmatter', () => {
  it('全 metadata を正式な YAML として生成し固定の同期時刻を保持する', () => {
    const frontmatter = createFrontmatter({
      notionId: 'page-id',
      notionUrl: 'https://www.notion.so/page-id',
      notionRootId: 'root-id',
      notionParentId: 'parent-id',
      notionObjectType: 'page',
      notionLastEditedTime: '2026-07-10T00:00:00.000Z',
      syncedAt: '2026-07-11T12:34:56.000Z',
      title: 'Title: 日本語\nsecond line 📝',
      contentHash: 'sha256-value',
    });

    expect(parseFrontmatter(frontmatter)).toEqual({
      managed_by: 'notion-to-obsidian',
      notion_id: 'page-id',
      notion_url: 'https://www.notion.so/page-id',
      notion_root_id: 'root-id',
      notion_parent_id: 'parent-id',
      notion_object_type: 'page',
      notion_last_edited_time: '2026-07-10T00:00:00.000Z',
      synced_at: '2026-07-11T12:34:56.000Z',
      title: 'Title: 日本語\nsecond line 📝',
      content_hash: 'sha256-value',
    });
  });

  it('root の親を null とし未指定の content hash を出力しない', () => {
    const frontmatter = createFrontmatter({
      notionId: 'root-id',
      notionUrl: 'https://www.notion.so/root-id',
      notionRootId: 'root-id',
      notionParentId: null,
      notionObjectType: 'page',
      notionLastEditedTime: '2026-07-10T00:00:00.000Z',
      syncedAt: '2026-07-11T00:00:00.000Z',
      title: 'Root',
    });

    expect(parseFrontmatter(frontmatter)).toMatchObject({
      notion_parent_id: null,
      synced_at: '2026-07-11T00:00:00.000Z',
    });
    expect(frontmatter).not.toContain('content_hash');
  });

  it('Data Source行のpropertyを専用namespaceへ追加する', () => {
    const frontmatter = createFrontmatter({
      notionId: 'page-id',
      notionUrl: 'https://www.notion.so/page-id',
      notionRootId: 'root-id',
      notionParentId: 'source-id',
      notionObjectType: 'page',
      notionLastEditedTime: '2026-07-12T00:00:00.000Z',
      syncedAt: '2026-07-12T01:00:00.000Z',
      title: 'Row',
      properties: {
        Status: 'Done',
        Tags: ['A', 'B'],
        Relation: {
          value: ['[[Tasks/Other]]'],
          raw: [{ id: 'other-id' }],
        },
      },
    });

    expect(parseFrontmatter(frontmatter)).toMatchObject({
      notion_properties: {
        Status: 'Done',
        Tags: ['A', 'B'],
        Relation: {
          value: ['[[Tasks/Other]]'],
          raw: [{ id: 'other-id' }],
        },
      },
    });
  });
});
