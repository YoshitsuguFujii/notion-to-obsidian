import {
  access,
  copyFile as nodeCopyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimTargetExclusively } from '../src/filesystem/exclusive-target-claim.js';

const targetExistsMessage = 'Target already exists; refresh the plan and retry';
const directories: string[] = [];

async function fixture(): Promise<{
  sourcePath: string;
  targetPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'notion-exclusive-target-'));
  directories.push(root);
  const sourcePath = join(root, 'source.md');
  const targetPath = join(root, 'target.md');
  await writeFile(sourcePath, 'managed content');
  return { sourcePath, targetPath };
}

function fileSystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('claimTargetExclusively', () => {
  it('sourceを残したままtargetを排他的に確立する', async () => {
    const { sourcePath, targetPath } = await fixture();

    await claimTargetExclusively({
      sourcePath,
      targetPath,
      targetExistsMessage,
    });

    expect(await readFile(sourcePath, 'utf8')).toBe('managed content');
    expect(await readFile(targetPath, 'utf8')).toBe('managed content');
  });

  it('targetが競合したら既存内容とsourceを保持して安全に停止する', async () => {
    const { sourcePath, targetPath } = await fixture();
    await writeFile(targetPath, 'unmanaged content');

    await expect(
      claimTargetExclusively({
        sourcePath,
        targetPath,
        targetExistsMessage,
      }),
    ).rejects.toMatchObject({
      category: 'safety',
      message: targetExistsMessage,
    });
    expect(await readFile(sourcePath, 'utf8')).toBe('managed content');
    expect(await readFile(targetPath, 'utf8')).toBe('unmanaged content');
  });

  it('分類外のストレージ障害ではコピーせず原因を再送出する', async () => {
    const { sourcePath, targetPath } = await fixture();
    const linkCause = fileSystemError('EIO', 'link failed');
    const copyFile = vi.fn<typeof nodeCopyFile>();

    await expect(
      claimTargetExclusively({
        sourcePath,
        targetPath,
        targetExistsMessage,
        link: () => Promise.reject(linkCause),
        copyFile,
      }),
    ).rejects.toBe(linkCause);
    expect(copyFile).not.toHaveBeenCalled();
    await expect(access(targetPath)).rejects.toThrow();
  });

  it('ハードリンクを使えない場合は排他的なコピーでtargetを確立する', async () => {
    const { sourcePath, targetPath } = await fixture();
    const copyFile = vi.fn(
      async (from: string, to: string, mode?: number): Promise<void> => {
        await nodeCopyFile(from, to, mode);
      },
    );

    await claimTargetExclusively({
      sourcePath,
      targetPath,
      targetExistsMessage,
      link: () => Promise.reject(fileSystemError('EXDEV', 'cross-device link')),
      copyFile,
    });

    expect(copyFile).toHaveBeenCalledWith(
      sourcePath,
      targetPath,
      constants.COPYFILE_EXCL,
    );
    expect(await readFile(sourcePath, 'utf8')).toBe('managed content');
    expect(await readFile(targetPath, 'utf8')).toBe('managed content');
  });

  it('排他的なコピーで競合したら既存内容とsourceを保持して安全に停止する', async () => {
    const { sourcePath, targetPath } = await fixture();
    await writeFile(targetPath, 'unmanaged content');

    await expect(
      claimTargetExclusively({
        sourcePath,
        targetPath,
        targetExistsMessage,
        link: () =>
          Promise.reject(fileSystemError('EXDEV', 'cross-device link')),
      }),
    ).rejects.toMatchObject({
      category: 'safety',
      message: targetExistsMessage,
    });
    expect(await readFile(sourcePath, 'utf8')).toBe('managed content');
    expect(await readFile(targetPath, 'utf8')).toBe('unmanaged content');
  });

  it('排他的なコピーが失敗したら不完全なtargetを除去して原因を再送出する', async () => {
    const { sourcePath, targetPath } = await fixture();
    const copyCause = fileSystemError('EIO', 'copy failed');

    await expect(
      claimTargetExclusively({
        sourcePath,
        targetPath,
        targetExistsMessage,
        link: () =>
          Promise.reject(fileSystemError('EXDEV', 'cross-device link')),
        copyFile: async (_from, to) => {
          await writeFile(to, 'partial content');
          throw copyCause;
        },
      }),
    ).rejects.toBe(copyCause);
    expect(await readFile(sourcePath, 'utf8')).toBe('managed content');
    await expect(access(targetPath)).rejects.toThrow();
  });
});
