import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trashManagedFile } from '../src/filesystem/trash.js';

const notionId = '11111111-1111-4111-8111-111111111111';
const markdown = `---\nmanaged_by: notion-to-obsidian\nnotion_id: ${notionId}\n---\nBody\n`;
const directories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'notion-trash-'));
  directories.push(root);
  await mkdir(join(root, 'Root'), { recursive: true });
  await writeFile(join(root, 'Root', 'Page.md'), markdown);
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

describe('trashManagedFile', () => {
  it('日付と元相対pathを保って退避し、理由をhookへ渡す', async () => {
    const root = await fixture();
    const onTrashed = vi.fn();
    const result = await trashManagedFile({
      managedRoot: root,
      sourcePath: 'Root/Page.md',
      notionId,
      stored: { notionId, localPath: 'Root/Page.md' },
      reason: 'notion_in_trash',
      date: '2026-07-12',
      onTrashed,
    });
    expect(result).toEqual({
      trashed: true,
      trashPath: '.trash/2026-07-12/Root/Page.md',
    });
    expect(await readFile(join(root, result.trashPath), 'utf8')).toBe(markdown);
    expect(onTrashed).toHaveBeenCalledWith({
      trashPath: result.trashPath,
      reason: 'notion_in_trash',
    });
  });

  it('同名退避先があればpage ID付きpathを使い、既存を上書きしない', async () => {
    const root = await fixture();
    const collision = join(root, '.trash', '2026-07-12', 'Root', 'Page.md');
    await mkdir(join(collision, '..'), { recursive: true });
    await writeFile(collision, 'existing');
    const result = await trashManagedFile({
      managedRoot: root,
      sourcePath: 'Root/Page.md',
      notionId,
      stored: { notionId, localPath: 'Root/Page.md' },
      reason: 'confirmed_not_found',
      date: '2026-07-12',
    });
    expect(result.trashPath).toBe('.trash/2026-07-12/Root/Page--11111111.md');
    expect(await readFile(collision, 'utf8')).toBe('existing');
  });

  it('管理対象外fileを退避しない', async () => {
    const root = await fixture();
    await writeFile(join(root, 'Root', 'Page.md'), 'unmanaged');
    await expect(
      trashManagedFile({
        managedRoot: root,
        sourcePath: 'Root/Page.md',
        notionId,
        stored: { notionId, localPath: 'Root/Page.md' },
        reason: 'manual_reconcile',
        date: '2026-07-12',
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('dry-runではtrash directoryを作らない', async () => {
    const root = await fixture();
    await expect(
      trashManagedFile({
        managedRoot: root,
        sourcePath: 'Root/Page.md',
        notionId,
        stored: { notionId, localPath: 'Root/Page.md' },
        reason: 'manual_reconcile',
        date: '2026-07-12',
        dryRun: true,
      }),
    ).resolves.toEqual({
      trashed: false,
      trashPath: '.trash/2026-07-12/Root/Page.md',
    });
    await expect(readFile(join(root, '.trash'))).rejects.toThrow();
  });

  it('trash pathがmanaged root外へのsymlinkなら退避しない', async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'notion-trash-outside-'));
    directories.push(outside);
    await symlink(outside, join(root, '.trash'));
    await expect(
      trashManagedFile({
        managedRoot: root,
        sourcePath: 'Root/Page.md',
        notionId,
        stored: { notionId, localPath: 'Root/Page.md' },
        reason: 'manual_reconcile',
        date: '2026-07-12',
      }),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(join(root, 'Root', 'Page.md'), 'utf8')).toBe(
      markdown,
    );
  });
});
