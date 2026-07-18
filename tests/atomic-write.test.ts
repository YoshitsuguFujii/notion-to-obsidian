import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
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

const notionId = '11111111-1111-4111-8111-111111111111';
const sidecarId = '22222222-2222-4222-8222-222222222222';

function managedMarkdown(body: string): string {
  return `---\nmanaged_by: notion-to-obsidian\nnotion_id: ${notionId}\n---\n${body}`;
}

function unsupportedSidecar(
  payload: unknown = { value: 1 },
  type = 'future_block',
): string {
  return `${JSON.stringify({ type, id: sidecarId, payload }, null, 2)}\n`;
}

function fileSystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
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

  it('対象が不在なら管理対象Markdownを排他的に作成する', async () => {
    const { directory, path } = await temporaryPath();
    const content = managedMarkdown('Body');

    await expect(
      writeMarkdownAtomic(path, content, {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
      }),
    ).resolves.toBe('written');

    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('対象の確認後に管理外ファイルが現れた場合は内容を保持して停止する', async () => {
    const { directory, path } = await temporaryPath();
    const unmanaged = 'Personal note';

    await expect(
      writeMarkdownAtomic(path, managedMarkdown('Body'), {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
        temporaryId: () => 'race',
        link: async (_source, target) => {
          await writeFile(target, unmanaged);
          throw fileSystemError('EEXIST', 'target appeared');
        },
      }),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(await readFile(path, 'utf8')).toBe(unmanaged);
    expect(await readdir(join(path, '..'))).toEqual(['Page.md']);
  });

  it('生成予定と同じ内容の管理外ファイルも取り込まず停止する', async () => {
    const { directory, path } = await temporaryPath();
    const content = managedMarkdown('Body');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);

    await expect(
      writeMarkdownAtomic(path, content, {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
      }),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('対象がdirectoryの場合は中身を変更せず停止する', async () => {
    const { directory, path } = await temporaryPath();
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'kept.txt'), 'Keep');

    await expect(
      writeMarkdownAtomic(path, managedMarkdown('Body'), {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
      }),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(await readFile(join(path, 'kept.txt'), 'utf8')).toBe('Keep');
  });

  it('管理対象ファイルを読めない場合は内容を保持してstorage errorを返す', async () => {
    const { directory, path } = await temporaryPath();
    const existing = managedMarkdown('Old body');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, existing);

    await expect(
      writeMarkdownAtomic(path, managedMarkdown('New body'), {
        managedRoot: directory,
        ownership: {
          kind: 'markdown-marker',
          stored: { notionId, localPath: 'nested/Page.md' },
        },
        readFile: () =>
          Promise.reject(fileSystemError('EACCES', 'permission denied')),
      }),
    ).rejects.toMatchObject({ category: 'storage' });

    expect(await readFile(path, 'utf8')).toBe(existing);
  });

  it('確定後に一時ファイルを除去できなくても書き込み成功として扱う', async () => {
    const { directory, path } = await temporaryPath();
    const content = managedMarkdown('Body');

    await expect(
      writeMarkdownAtomic(path, content, {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
        temporaryId: () => 'kept',
        unlink: () =>
          Promise.reject(fileSystemError('EACCES', 'cannot remove temp')),
      }),
    ).resolves.toBe('written');

    expect(await readFile(path, 'utf8')).toBe(content);
    expect(
      await readFile(join(directory, 'nested', '.Page.md.kept.tmp'), 'utf8'),
    ).toBe(content);
  });

  it('一時ファイルの除去が一時的に失敗した場合は再試行して後始末する', async () => {
    const { directory, path } = await temporaryPath();
    let unavailable = true;

    await expect(
      writeMarkdownAtomic(path, managedMarkdown('Body'), {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
        temporaryId: () => 'retried',
        unlink: async (temporaryPath) => {
          if (unavailable) {
            unavailable = false;
            throw fileSystemError('EBUSY', 'temporarily busy');
          }
          await unlink(temporaryPath);
        },
      }),
    ).resolves.toBe('written');

    expect(await readdir(join(path, '..'))).toEqual(['Page.md']);
  });

  it('管理対象ファイルが同じ内容ならmtimeを維持し差分があれば置換する', async () => {
    const { directory, path } = await temporaryPath();
    const existing = managedMarkdown('Old body');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, existing);
    const before = (await stat(path)).mtimeMs;
    const options = {
      managedRoot: directory,
      ownership: {
        kind: 'markdown-marker' as const,
        stored: { notionId, localPath: 'nested/Page.md' },
      },
    };

    await expect(writeMarkdownAtomic(path, existing, options)).resolves.toBe(
      'unchanged',
    );
    expect((await stat(path)).mtimeMs).toBe(before);

    const updated = managedMarkdown('New body');
    await expect(writeMarkdownAtomic(path, updated, options)).resolves.toBe(
      'written',
    );
    expect(await readFile(path, 'utf8')).toBe(updated);
  });

  it('管理情報と一致しない対象は内容を保持して停止する', async () => {
    const { directory, path } = await temporaryPath();
    const existing = managedMarkdown('Personal copy');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, existing);

    await expect(
      writeMarkdownAtomic(path, managedMarkdown('Synced body'), {
        managedRoot: directory,
        ownership: {
          kind: 'markdown-marker',
          stored: { notionId, localPath: 'another/Page.md' },
        },
      }),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(await readFile(path, 'utf8')).toBe(existing);
  });

  it('排他確保の分類外エラーはstorage errorとして返し対象を作らない', async () => {
    const { directory, path } = await temporaryPath();

    await expect(
      writeMarkdownAtomic(path, managedMarkdown('Body'), {
        managedRoot: directory,
        ownership: { kind: 'markdown-marker', stored: undefined },
        temporaryId: () => 'failed',
        link: () => Promise.reject(fileSystemError('EIO', 'link failed')),
      }),
    ).rejects.toMatchObject({ category: 'storage' });

    expect(await readdir(join(path, '..'))).toEqual([]);
  });

  it('保護オプションを省略した場合は既存対象を置換する', async () => {
    const { path } = await temporaryPath();
    await writeMarkdownAtomic(path, 'Old body');

    await expect(writeMarkdownAtomic(path, 'New body')).resolves.toBe(
      'written',
    );
    expect(await readFile(path, 'utf8')).toBe('New body');
  });

  it('対象が不在ならページ記録なしでもunsupported sidecarを排他的に作成する', async () => {
    const { directory } = await temporaryPath();
    const path = join(directory, '_unsupported', notionId, `${sidecarId}.json`);
    const content = unsupportedSidecar();

    await expect(
      writeMarkdownAtomic(path, content, {
        managedRoot: directory,
        ownership: {
          kind: 'unsupported-sidecar',
          expectedPageId: notionId,
          expectedSidecarId: sidecarId,
          storedPage: undefined,
        },
      }),
    ).resolves.toBe('written');

    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('unsupported sidecarの確認後に対象が現れた場合は内容を保持して停止する', async () => {
    const { directory } = await temporaryPath();
    const path = join(directory, '_unsupported', notionId, `${sidecarId}.json`);
    const unmanaged = '{"personal":true}\n';

    await expect(
      writeMarkdownAtomic(path, unsupportedSidecar(), {
        managedRoot: directory,
        ownership: {
          kind: 'unsupported-sidecar',
          expectedPageId: notionId,
          expectedSidecarId: sidecarId,
          storedPage: undefined,
        },
        temporaryId: () => 'race',
        link: async (_source, target) => {
          await writeFile(target, unmanaged);
          throw fileSystemError('EEXIST', 'target appeared');
        },
      }),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(await readFile(path, 'utf8')).toBe(unmanaged);
  });

  it('所有契約を満たさないunsupported sidecarは内容を保持して停止する', async () => {
    const { directory } = await temporaryPath();
    const path = join(directory, '_unsupported', notionId, `${sidecarId}.json`);
    const unmanaged = `${JSON.stringify({ type: 'future_block', id: 'other', payload: {} })}\n`;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, unmanaged);

    await expect(
      writeMarkdownAtomic(path, unsupportedSidecar(), {
        managedRoot: directory,
        ownership: {
          kind: 'unsupported-sidecar',
          expectedPageId: notionId,
          expectedSidecarId: sidecarId,
          storedPage: { notionId },
        },
      }),
    ).rejects.toMatchObject({
      category: 'safety',
      message: expect.stringContaining('Unsupported sidecar target'),
    });

    expect(await readFile(path, 'utf8')).toBe(unmanaged);
  });

  it('管理対象unsupported sidecarは同内容ならmtimeを維持しpayloadまたはtypeの差分を置換する', async () => {
    const { directory } = await temporaryPath();
    const path = join(directory, '_unsupported', notionId, `${sidecarId}.json`);
    const existing = unsupportedSidecar();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, existing);
    const before = (await stat(path)).mtimeMs;
    const options = {
      managedRoot: directory,
      ownership: {
        kind: 'unsupported-sidecar' as const,
        expectedPageId: notionId,
        expectedSidecarId: sidecarId,
        storedPage: { notionId },
      },
    };

    await expect(writeMarkdownAtomic(path, existing, options)).resolves.toBe(
      'unchanged',
    );
    expect((await stat(path)).mtimeMs).toBe(before);

    const changedPayload = unsupportedSidecar({ value: 2 });
    await expect(
      writeMarkdownAtomic(path, changedPayload, options),
    ).resolves.toBe('written');
    expect(await readFile(path, 'utf8')).toBe(changedPayload);

    const changedType = unsupportedSidecar({ value: 2 }, 'another_block');
    await expect(writeMarkdownAtomic(path, changedType, options)).resolves.toBe(
      'written',
    );
    expect(await readFile(path, 'utf8')).toBe(changedType);
  });

  it('unsupported sidecarがdirectoryの場合は内容を保持してsafety errorを返す', async () => {
    const { directory } = await temporaryPath();
    const path = join(directory, '_unsupported', notionId, `${sidecarId}.json`);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'kept.txt'), 'Keep');

    await expect(
      writeMarkdownAtomic(path, unsupportedSidecar(), {
        managedRoot: directory,
        ownership: {
          kind: 'unsupported-sidecar',
          expectedPageId: notionId,
          expectedSidecarId: sidecarId,
          storedPage: { notionId },
        },
      }),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(await readFile(join(path, 'kept.txt'), 'utf8')).toBe('Keep');
  });

  it('unsupported sidecarを読めない場合は内容を保持してstorage errorを返す', async () => {
    const { directory } = await temporaryPath();
    const path = join(directory, '_unsupported', notionId, `${sidecarId}.json`);
    const existing = unsupportedSidecar();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, existing);

    await expect(
      writeMarkdownAtomic(path, unsupportedSidecar({ value: 2 }), {
        managedRoot: directory,
        ownership: {
          kind: 'unsupported-sidecar',
          expectedPageId: notionId,
          expectedSidecarId: sidecarId,
          storedPage: { notionId },
        },
        readFile: () =>
          Promise.reject(fileSystemError('EACCES', 'permission denied')),
      }),
    ).rejects.toMatchObject({ category: 'storage' });

    expect(await readFile(path, 'utf8')).toBe(existing);
  });
});
