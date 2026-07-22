import { describe, expect, it } from 'vitest';
import { inspectManagementMarker } from '../src/filesystem/management-marker.js';

const notionId = '11111111-1111-8111-9111-111111111111';

function markdown(id: string, managedBy = 'notion-to-obsidian'): string {
  return `---\nmanaged_by: ${managedBy}\nnotion_id: ${id}\n---\nBody\n`;
}

function managed(id: string, storedId = id): boolean {
  return inspectManagementMarker({
    managedRoot: '/vault/managed',
    filePath: '/vault/managed/Page.md',
    content: markdown(id),
    stored: { notionId: storedId, localPath: 'Page.md' },
  }).managed;
}

describe('inspectManagementMarker', () => {
  it.each([
    ['v4', '11111111-1111-4111-8111-111111111111'],
    ['version 8 / variant 9', '22222222-2222-8222-9222-222222222222'],
    ['version 8 / variant a', '33333333-3333-8333-a333-333333333333'],
    ['version 8 / variant b', '44444444-4444-8444-b444-444444444444'],
  ])('%s形状のIDとDBの管理情報が一致すれば管理対象とする', (_label, id) => {
    expect(managed(id)).toBe(true);
  });

  it.each([
    ['31桁', '11111111-1111-8111-9111-11111111111'],
    ['33桁', '11111111-1111-8111-9111-1111111111111'],
    ['16進以外', 'g1111111-1111-8111-9111-111111111111'],
    ['ダッシュ位置違い', '1111111-11111-8111-9111-111111111111'],
    ['空文字', ''],
    ['compact 32桁', '11111111111181119111111111111111'],
  ])('%sのIDは管理対象として受理しない', (_label, id) => {
    expect(managed(id, notionId)).toBe(false);
  });

  it('managed_byが異なるファイルは管理対象外にする', () => {
    expect(
      inspectManagementMarker({
        managedRoot: '/vault/managed',
        filePath: '/vault/managed/Page.md',
        content: markdown(notionId, 'other'),
        stored: { notionId, localPath: 'Page.md' },
      }).managed,
    ).toBe(false);
  });

  it('markerとDBのIDが大文字小文字だけ異なっても管理対象外にする', () => {
    const lowercaseId = 'aaaaaaaa-aaaa-8aaa-9aaa-aaaaaaaaaaaa';
    expect(managed(lowercaseId.toUpperCase(), lowercaseId)).toBe(false);
  });

  it.each([
    ['root外', { filePath: '/vault/other/Page.md' }],
    [
      'DB ID不一致',
      {
        stored: {
          notionId: '22222222-2222-8222-9222-222222222222',
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
        content: markdown(notionId),
        stored: { notionId, localPath: 'Page.md' },
        ...override,
      }).managed,
    ).toBe(false);
  });
});
