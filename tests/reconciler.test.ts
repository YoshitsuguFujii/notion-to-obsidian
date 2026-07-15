import { describe, expect, it } from 'vitest';
import { reconcileResource } from '../src/sync/reconciler.js';

const current = {
  notionId: 'page-id',
  title: 'Title',
  parentId: 'parent-id',
  rootId: 'root-id',
  lastEditedTime: '2026-07-12T00:00:00.000Z',
  expectedPath: 'Root/Title.md',
  resolvedFilename: 'Title',
  contentHash: 'content-1',
  structureHash: 'structure-1',
  configHash: 'config-1',
  transformVersion: 'transform-1',
  apiVersion: '2026-03-11',
  assetFingerprint: 'assets-1',
};

const stored = { ...current, localPath: current.expectedPath };

describe('reconcileResource', () => {
  it('保存状態が無ければ CREATE にする', () => {
    expect(reconcileResource(undefined, current)).toMatchObject({
      type: 'CREATE',
      notionId: 'page-id',
    });
  });

  it.each([
    ['notionId', 'other-page-id', 'notion_id'],
    ['lastEditedTime', '2026-07-12T01:00:00.000Z', 'last_edited_time'],
    ['contentHash', 'content-2', 'content'],
    ['structureHash', 'structure-2', 'structure'],
    ['configHash', 'config-2', 'config'],
    ['transformVersion', 'transform-2', 'transform_version'],
    ['apiVersion', '2027-01-01', 'api_version'],
    ['assetFingerprint', 'assets-2', 'asset'],
    ['title', 'Renamed', 'title'],
    ['parentId', 'other-parent', 'parent'],
    ['rootId', 'other-root', 'root'],
    ['resolvedFilename', 'Title--pageid', 'collision'],
  ] as const)('%s の変化を検出する', (key, value, reason) => {
    expect(
      reconcileResource(stored, { ...current, [key]: value }),
    ).toMatchObject({ type: 'UPDATE', reasons: [reason] });
  });

  it('出力パスが変われば MOVE にする', () => {
    expect(
      reconcileResource(stored, {
        ...current,
        expectedPath: 'Root/Renamed.md',
      }),
    ).toMatchObject({ type: 'MOVE', reasons: ['local_path'] });
  });

  it('タイトルと本文の同時変更を両方保持する', () => {
    expect(
      reconcileResource(stored, {
        ...current,
        title: 'Renamed',
        contentHash: 'content-2',
      }),
    ).toMatchObject({ type: 'UPDATE', reasons: ['title', 'content'] });
  });

  it('同じ入力を繰り返すと完全に UNCHANGED になる', () => {
    const first = reconcileResource(stored, current);
    const second = reconcileResource(stored, current);
    expect(first).toEqual({
      type: 'UNCHANGED',
      notionId: 'page-id',
      reasons: [],
    });
    expect(second).toEqual(first);
  });
});
