import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectUnsupportedSidecarTarget,
  unsupportedSidecarPath,
} from '../src/filesystem/unsupported-sidecar-target.js';

const pageId = '11111111-1111-4111-8111-111111111111';
const sidecarId = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];

function sidecarContent(
  override: Record<string, unknown> = {},
): string {
  return `${JSON.stringify(
    { type: 'future_block', id: sidecarId, payload: { value: 1 }, ...override },
    null,
    2,
  )}\n`;
}

async function fixture(): Promise<{ managedRoot: string; targetPath: string }> {
  const managedRoot = await mkdtemp(join(tmpdir(), 'notion-sidecar-target-'));
  directories.push(managedRoot);
  const targetPath = unsupportedSidecarPath(managedRoot, pageId, sidecarId);
  await mkdir(dirname(targetPath), { recursive: true });
  return { managedRoot, targetPath };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('inspectUnsupportedSidecarTarget', () => {
  it('対象が存在しない場合は新規作成可能と分類する', async () => {
    const { managedRoot, targetPath } = await fixture();

    await expect(
      inspectUnsupportedSidecarTarget({
        managedRoot,
        targetPath,
        expectedPageId: pageId,
        expectedSidecarId: sidecarId,
        storedPage: undefined,
      }),
    ).resolves.toEqual({ kind: 'absent' });
  });

  it.each(['active', 'missing', 'tombstoned'])(
    'ページ記録が%sでも正準パスと厳格なJSONが一致すれば管理対象と分類する',
    async (status) => {
      const { managedRoot, targetPath } = await fixture();
      const content = sidecarContent();
      const storedPage = {
        notionId: pageId,
        status,
        localPath: 'Other.md',
      };
      await writeFile(targetPath, content);

      await expect(
        inspectUnsupportedSidecarTarget({
          managedRoot,
          targetPath,
          expectedPageId: pageId,
          expectedSidecarId: sidecarId,
          storedPage,
        }),
      ).resolves.toEqual({ kind: 'owned', content });
    },
  );

  it.each([
    ['ページdirectory', (root: string) => join(root, '_unsupported', 'other', `${sidecarId}.json`)],
    ['filename stem', (root: string) => join(root, '_unsupported', pageId, 'other.json')],
    ['拡張子', (root: string) => join(root, '_unsupported', pageId, `${sidecarId}.txt`)],
    ['階層数', (root: string) => join(root, '_unsupported', pageId, 'extra', `${sidecarId}.json`)],
  ])('%sが正準パスと異なる場合は所有契約を満たさない', async (_label, pathFor) => {
    const { managedRoot } = await fixture();
    const targetPath = pathFor(managedRoot);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, sidecarContent());

    await expect(
      inspectUnsupportedSidecarTarget({
        managedRoot,
        targetPath,
        expectedPageId: pageId,
        expectedSidecarId: sidecarId,
        storedPage: { notionId: pageId },
      }),
    ).resolves.toEqual({ kind: 'unmanaged' });
  });

  it.each([
    ['ID不一致', sidecarContent({ id: 'other' })],
    ['null', 'null\n'],
    ['配列', '[]\n'],
    ['追加キー', sidecarContent({ note: 'manual' })],
    ['JSON構文エラー', '{\n'],
    [
      'payload欠落',
      `${JSON.stringify({ type: 'future_block', id: sidecarId })}\n`,
    ],
    ['IDが文字列でない', sidecarContent({ id: 1 })],
    ['typeが文字列でない', sidecarContent({ type: 1 })],
  ])('%sのJSONは所有契約を満たさない', async (_label, content) => {
    const { managedRoot, targetPath } = await fixture();
    await writeFile(targetPath, content);

    await expect(
      inspectUnsupportedSidecarTarget({
        managedRoot,
        targetPath,
        expectedPageId: pageId,
        expectedSidecarId: sidecarId,
        storedPage: { notionId: pageId },
      }),
    ).resolves.toEqual({ kind: 'unmanaged' });
  });

  it.each([undefined, { notionId: 'other' }])(
    'ページ記録が対象ページと一致しない場合は所有契約を満たさない',
    async (storedPage) => {
      const { managedRoot, targetPath } = await fixture();
      await writeFile(targetPath, sidecarContent());

      await expect(
        inspectUnsupportedSidecarTarget({
          managedRoot,
          targetPath,
          expectedPageId: pageId,
          expectedSidecarId: sidecarId,
          storedPage,
        }),
      ).resolves.toEqual({ kind: 'unmanaged' });
    },
  );

  it('directoryは内容を読まず非通常対象と分類する', async () => {
    const { managedRoot, targetPath } = await fixture();
    await mkdir(targetPath);

    await expect(
      inspectUnsupportedSidecarTarget({
        managedRoot,
        targetPath,
        expectedPageId: pageId,
        expectedSidecarId: sidecarId,
        storedPage: { notionId: pageId },
      }),
    ).resolves.toEqual({ kind: 'not-regular' });
  });

  it('通常ファイルを読めない場合は読取不能と分類して内容を保持する', async () => {
    const { managedRoot, targetPath } = await fixture();
    const content = sidecarContent();
    await writeFile(targetPath, content);

    await expect(
      inspectUnsupportedSidecarTarget(
        {
          managedRoot,
          targetPath,
          expectedPageId: pageId,
          expectedSidecarId: sidecarId,
          storedPage: { notionId: pageId },
        },
        { readFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) },
      ),
    ).resolves.toEqual({ kind: 'unreadable' });
    expect(await readFile(targetPath, 'utf8')).toBe(content);
  });

  it('対象の属性をENOENT以外で取得できない場合はstorage errorを返す', async () => {
    const { managedRoot, targetPath } = await fixture();

    await expect(
      inspectUnsupportedSidecarTarget(
        {
          managedRoot,
          targetPath,
          expectedPageId: pageId,
          expectedSidecarId: sidecarId,
          storedPage: { notionId: pageId },
        },
        { lstat: () => Promise.reject(Object.assign(new Error('I/O error'), { code: 'EIO' })) },
      ),
    ).rejects.toMatchObject({ category: 'storage' });
  });

  it.each([
    ['payload', sidecarContent({ payload: { value: 2 } })],
    ['type', sidecarContent({ type: 'another_block' })],
  ])('%sの差分は所有判定に影響しない', async (_label, content) => {
    const { managedRoot, targetPath } = await fixture();
    await writeFile(targetPath, content);

    await expect(
      inspectUnsupportedSidecarTarget({
        managedRoot,
        targetPath,
        expectedPageId: pageId,
        expectedSidecarId: sidecarId,
        storedPage: { notionId: pageId },
      }),
    ).resolves.toEqual({ kind: 'owned', content });
  });
});
