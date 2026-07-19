import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planUnsupportedSidecars } from '../src/sync/unsupported-sidecar-plan.js';

const managedRoot = resolve('/tmp/notion-managed');
const pageId = '11111111-1111-4111-8111-111111111111';

describe('planUnsupportedSidecars', () => {
  it('payloadがundefinedの場合は3キーのJSONとしてnullを保存する', () => {
    const [planned] = planUnsupportedSidecars({
      managedRoot,
      pageId,
      sidecars: [{ type: 'future_block', id: 'block-1', payload: undefined }],
    });

    expect(JSON.parse(planned?.content ?? '')).toEqual({
      type: 'future_block',
      id: 'block-1',
      payload: null,
    });
  });

  it.each([
    ['false', false],
    ['0', 0],
    ['空文字', ''],
    ['null', null],
  ])('payloadが%sの場合は値を維持する', (_label, payload) => {
    const [planned] = planUnsupportedSidecars({
      managedRoot,
      pageId,
      sidecars: [{ type: 'future_block', id: 'block-1', payload }],
    });

    expect(JSON.parse(planned?.content ?? '')).toEqual({
      type: 'future_block',
      id: 'block-1',
      payload,
    });
  });

  it('同じIDと内容の重複は1つの書き込みに集約する', () => {
    const sidecar = { type: 'future_block', id: 'block-1', payload: { a: 1 } };

    expect(
      planUnsupportedSidecars({
        managedRoot,
        pageId,
        sidecars: [sidecar, { ...sidecar }],
      }),
    ).toHaveLength(1);
  });

  it('同じIDに異なる内容がある場合は情報を選別せず停止する', () => {
    expect(() =>
      planUnsupportedSidecars({
        managedRoot,
        pageId,
        sidecars: [
          { type: 'unavailable', id: 'block-1', payload: null },
          { type: 'future_block', id: 'block-1', payload: { a: 1 } },
        ],
      }),
    ).toThrowError(expect.objectContaining({ category: 'safety' }));
  });

  it.each([
    ['sanitize結果', 'a/b', 'a:b'],
    ['大文字小文字', 'Block-A', 'block-a'],
    ['Unicode合成形式', 'Cafe\u0301', 'Café'],
  ])('%sだけが異なるIDの出力衝突を拒否する', (_label, first, second) => {
    expect(() =>
      planUnsupportedSidecars({
        managedRoot,
        pageId,
        sidecars: [
          { type: 'future_block', id: first, payload: {} },
          { type: 'future_block', id: second, payload: {} },
        ],
      }),
    ).toThrowError(expect.objectContaining({ category: 'safety' }));
  });

  it('書き込み内容とsidecar単位の識別子を返す', () => {
    const [planned] = planUnsupportedSidecars({
      managedRoot,
      pageId,
      sidecars: [{ type: 'future_block', id: 'block-1', payload: {} }],
    });

    expect(planned).toMatchObject({
      pageId,
      sidecarId: 'block-1',
      actionId: `sidecar:${pageId}:block-1`,
      content:
        '{\n  "type": "future_block",\n  "id": "block-1",\n  "payload": {}\n}\n',
    });
  });
});
