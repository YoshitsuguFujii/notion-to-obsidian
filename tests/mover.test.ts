import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveManagedFile } from '../src/filesystem/mover.js';

const notionId = '11111111-1111-4111-8111-111111111111';
const directories: string[] = [];
const markdown = `---\nmanaged_by: notion-to-obsidian\nnotion_id: ${notionId}\n---\nBody\n`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'notion-move-'));
  directories.push(root);
  await mkdir(join(root, 'Old'), { recursive: true });
  await writeFile(join(root, 'Old', 'Page.md'), markdown);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('moveManagedFile', () => {
  it('移動完了後にhookを呼び、空の旧directoryを削除する', async () => {
    const root = await fixture();
    const onMoved = vi.fn();
    const result = await moveManagedFile({
      managedRoot: root,
      sourcePath: 'Old/Page.md',
      targetPath: 'New/Page.md',
      stored: { notionId, localPath: 'Old/Page.md' },
      onMoved,
    });
    expect(result).toEqual({
      moved: true,
      targetPath: 'New/Page.md',
    });
    expect(await readFile(join(root, 'New', 'Page.md'), 'utf8')).toBe(markdown);
    await expect(access(join(root, 'Old'))).rejects.toThrow();
    expect(onMoved).toHaveBeenCalledWith('New/Page.md');
  });

  it('異なるファイルシステム間では排他的なコピーで移動を完了する', async () => {
    const root = await fixture();
    await moveManagedFile({
      managedRoot: root,
      sourcePath: 'Old/Page.md',
      targetPath: 'New/Page.md',
      stored: { notionId, localPath: 'Old/Page.md' },
      link: () =>
        Promise.reject(
          Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
        ),
    });
    expect(await readFile(join(root, 'New', 'Page.md'), 'utf8')).toBe(markdown);
    await expect(access(join(root, 'Old', 'Page.md'))).rejects.toThrow();
  });

  it('排他的なコピーが完了しなければ移動元を残し、不完全な移動先を除去する', async () => {
    const root = await fixture();
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
        link: () =>
          Promise.reject(
            Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
          ),
        copyFile: async (_from, to) => {
          await writeFile(to, 'partial');
          throw new Error('copy failed');
        },
      }),
    ).rejects.toMatchObject({ category: 'storage' });
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
    await expect(access(join(root, 'New', 'Page.md'))).rejects.toThrow();
  });

  it('移動直前に管理外ファイルが作られたら内容と移動元を保持して安全に停止する', async () => {
    const root = await fixture();
    const target = join(root, 'New', 'Page.md');
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
        link: async () => {
          await writeFile(target, 'unmanaged');
          throw Object.assign(new Error('target exists'), { code: 'EEXIST' });
        },
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(target, 'utf8')).toBe('unmanaged');
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
  });

  it('排他的なコピー直前に管理外ファイルが作られたら内容と移動元を保持して安全に停止する', async () => {
    const root = await fixture();
    const target = join(root, 'New', 'Page.md');
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
        link: () =>
          Promise.reject(
            Object.assign(new Error('cross-device'), { code: 'EXDEV' }),
          ),
        copyFile: async (_from, _to, mode) => {
          await writeFile(target, 'unmanaged');
          if (mode === constants.COPYFILE_EXCL) {
            throw Object.assign(new Error('target exists'), {
              code: 'EEXIST',
            });
          }
          await writeFile(target, markdown);
        },
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(target, 'utf8')).toBe('unmanaged');
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
  });

  it('ストレージ障害ではコピーせず移動元を保持して失敗を報告する', async () => {
    const root = await fixture();
    const linkError = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
        link: () => Promise.reject(linkError),
        copyFile: () => Promise.reject(new Error('copy must not run')),
      }),
    ).rejects.toMatchObject({ category: 'storage', cause: linkError });
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
    await expect(access(join(root, 'New', 'Page.md'))).rejects.toThrow();
  });

  it('移動先の確立後に移動元を削除できなければ両方を保持して失敗を報告する', async () => {
    const root = await fixture();
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
        link,
        unlink: () => Promise.reject(new Error('unlink failed')),
      }),
    ).rejects.toMatchObject({ category: 'storage' });
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
    expect(await readFile(join(root, 'New', 'Page.md'), 'utf8')).toBe(markdown);
  });

  it('確定後のMOVE先にファイルが作られていたら移動を停止する', async () => {
    const root = await fixture();
    await mkdir(join(root, 'New'), { recursive: true });
    await writeFile(join(root, 'New', 'Page.md'), 'unmanaged');
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(join(root, 'New', 'Page.md'), 'utf8')).toBe(
      'unmanaged',
    );
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
  });

  it('移動先に管理外ディレクトリがあれば内容と移動元を保持して安全に停止する', async () => {
    const root = await fixture();
    await mkdir(join(root, 'New', 'Page.md'), { recursive: true });
    await writeFile(join(root, 'New', 'Page.md', 'notes.txt'), 'keep');
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(
      await readFile(join(root, 'New', 'Page.md', 'notes.txt'), 'utf8'),
    ).toBe('keep');
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(markdown);
  });

  it('旧directoryに管理外ファイルがあればdirectoryを残す', async () => {
    const root = await fixture();
    await writeFile(join(root, 'Old', 'notes.txt'), 'keep');
    await moveManagedFile({
      managedRoot: root,
      sourcePath: 'Old/Page.md',
      targetPath: 'New/Page.md',
      stored: { notionId, localPath: 'Old/Page.md' },
    });
    expect(await readdir(join(root, 'Old'))).toEqual(['notes.txt']);
  });

  it('管理対象外sourceを変更しない', async () => {
    const root = await fixture();
    await writeFile(join(root, 'Old', 'Page.md'), 'unmanaged');
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(join(root, 'Old', 'Page.md'), 'utf8')).toBe(
      'unmanaged',
    );
  });

  it('file確定後のDB hook失敗を報告し、復旧可能なnew fileを保持する', async () => {
    const root = await fixture();
    await expect(
      moveManagedFile({
        managedRoot: root,
        sourcePath: 'Old/Page.md',
        targetPath: 'New/Page.md',
        stored: { notionId, localPath: 'Old/Page.md' },
        onMoved: () => Promise.reject(new Error('DB update failed')),
      }),
    ).rejects.toMatchObject({ category: 'storage' });
    expect(await readFile(join(root, 'New', 'Page.md'), 'utf8')).toBe(markdown);
    await expect(access(join(root, 'Old', 'Page.md'))).rejects.toThrow();
  });
});
