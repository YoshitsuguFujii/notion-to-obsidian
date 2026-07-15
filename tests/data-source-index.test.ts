import { describe, expect, it } from 'vitest';
import { createDataSourceIndex } from '../src/transform/data-source-index.js';

describe('createDataSourceIndex', () => {
  it('Data Source metadata、schema概要、行WikiLinkを生成する', () => {
    const markdown = createDataSourceIndex({
      name: 'Tasks',
      notionUrl: 'https://www.notion.so/source-id',
      dataSourceId: 'source-id',
      schema: [
        { name: 'Name', type: 'title' },
        { name: 'Status', type: 'status' },
      ],
      rows: [
        { title: 'First task', path: 'Tasks/First task.md' },
        { title: 'Second task', path: 'Tasks/Second task.md' },
      ],
      syncedAt: '2026-07-12T09:00:00.000Z',
    });

    expect(markdown).toContain('notion_data_source_id: source-id');
    expect(markdown).toContain('notion_url: https://www.notion.so/source-id');
    expect(markdown).toContain('synced_at: 2026-07-12T09:00:00.000Z');
    expect(markdown).toContain('# Tasks');
    expect(markdown).toContain('| Name | title |');
    expect(markdown).toContain('| Status | status |');
    expect(markdown).toContain('- [[Tasks/First task|First task]]');
    expect(markdown).toContain('- [[Tasks/Second task|Second task]]');
  });

  it('改行とMarkdown区切り文字をescapeして構造を保持する', () => {
    const markdown = createDataSourceIndex({
      name: 'Tasks\nInjected',
      notionUrl: 'https://www.notion.so/source-id',
      dataSourceId: 'source-id',
      schema: [{ name: 'Name | Type', type: 'rich_text\nextra' }],
      rows: [{ title: 'Alias | value]', path: 'Tasks/Row].md' }],
      syncedAt: '2026-07-12T09:00:00.000Z',
    });

    expect(markdown).toContain('# Tasks Injected');
    expect(markdown).toContain('| Name \\| Type | rich_text extra |');
    expect(markdown).toContain('[[Tasks/Row\\]|Alias \\| value\\]]]');
    expect(markdown).not.toContain('\nInjected\n');
  });

  it('API由来のHTML文字をentity化する', () => {
    const markdown = createDataSourceIndex({
      name: '<script>alert(1)</script>',
      notionUrl: 'https://www.notion.so/source-id',
      dataSourceId: 'source-id',
      schema: [{ name: '<img>', type: 'title' }],
      rows: [{ title: '<b>row</b>', path: 'Tasks/Row.md' }],
      syncedAt: '2026-07-12T09:00:00.000Z',
    });

    expect(markdown).toContain('# &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markdown).toContain('| &lt;img&gt; | title |');
    expect(markdown).toContain('[[Tasks/Row|&lt;b&gt;row&lt;/b&gt;]]');
    expect(markdown).not.toContain('<script>');
  });
});
