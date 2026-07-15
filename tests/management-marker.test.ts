import { describe, expect, it } from 'vitest';
import { inspectManagementMarker } from '../src/filesystem/management-marker.js';

const notionId = '11111111-1111-4111-8111-111111111111';
const content = `---\nmanaged_by: notion-to-obsidian\nnotion_id: ${notionId}\n---\nBody\n`;

describe('inspectManagementMarker', () => {
  it('managed root、frontmatter、DB notion ID/pathがすべて一致すれば管理対象とする', () => {
    expect(
      inspectManagementMarker({
        managedRoot: '/vault/managed',
        filePath: '/vault/managed/Page.md',
        content,
        stored: { notionId, localPath: 'Page.md' },
      }),
    ).toEqual({ managed: true, notionId, contentHash: undefined });
  });

  it.each([
    ['root外', { filePath: '/vault/other/Page.md' }],
    [
      'marker不一致',
      { content: content.replace('notion-to-obsidian', 'other') },
    ],
    ['無効UUID', { content: content.replace(notionId, 'not-a-uuid') }],
    [
      'DB ID不一致',
      {
        stored: {
          notionId: '22222222-2222-4222-8222-222222222222',
          localPath: 'Page.md',
        },
      },
    ],
    ['DB path不一致', { stored: { notionId, localPath: 'Other.md' } }],
  ])('%sなら管理対象外にする', (_label, override) => {
    expect(
      inspectManagementMarker({
        managedRoot: '/vault/managed',
        filePath: '/vault/managed/Page.md',
        content,
        stored: { notionId, localPath: 'Page.md' },
        ...override,
      }).managed,
    ).toBe(false);
  });
});
