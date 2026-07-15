import { mkdtemp, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeMarkdownAtomic } from '../src/filesystem/atomic-write.js';

const directories: string[] = [];

async function temporaryPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'notion-atomic-'));
  directories.push(directory);
  return { directory, path: join(directory, 'nested', 'Page.md') };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('writeMarkdownAtomic', () => {
  it('同一directoryのtmpを確定後にrenameする', async () => {
    const { path } = await temporaryPath();
    await expect(
      writeMarkdownAtomic(path, 'Body', { temporaryId: () => 'id' }),
    ).resolves.toBe('written');
    expect(await readFile(path, 'utf8')).toBe('Body');
    expect(await readdir(join(path, '..'))).toEqual(['Page.md']);
  });

  it('同じ内容なら書き込まずmtimeを維持する', async () => {
    const { path } = await temporaryPath();
    await writeMarkdownAtomic(path, 'Body');
    const before = (await stat(path)).mtimeMs;
    await expect(writeMarkdownAtomic(path, 'Body')).resolves.toBe('unchanged');
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  it('rename失敗時にtmpを残さない', async () => {
    const { path } = await temporaryPath();
    await expect(
      writeMarkdownAtomic(path, 'Body', {
        temporaryId: () => 'id',
        rename: () => Promise.reject(new Error('rename failed')),
      }),
    ).rejects.toThrow('rename failed');
    expect(await readdir(join(path, '..'))).toEqual([]);
  });

  it('dry-runではdirectoryも作成しない', async () => {
    const { directory, path } = await temporaryPath();
    await expect(
      writeMarkdownAtomic(path, 'Body', { dryRun: true }),
    ).resolves.toBe('skipped');
    expect(await readdir(directory)).toEqual([]);
  });

  it('managed root外へ向くsymlink経由の書き込みを拒否する', async () => {
    const { directory } = await temporaryPath();
    const outside = await mkdtemp(join(tmpdir(), 'notion-atomic-outside-'));
    directories.push(outside);
    await symlink(outside, join(directory, 'link'));
    await expect(
      writeMarkdownAtomic(join(directory, 'link', 'Page.md'), 'Body', {
        managedRoot: directory,
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readdir(outside)).toEqual([]);
  });
});
