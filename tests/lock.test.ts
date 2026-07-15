import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLock } from '../src/storage/lock.js';

const directories: string[] = [];

async function lockFixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'notion-lock-'));
  directories.push(directory);
  return { directory, path: join(directory, '.state', '.lock') };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('FileLock', () => {
  it('lockを排他的に取得して所有者が解放する', async () => {
    const { path } = await lockFixture();
    const lock = new FileLock(path, { pid: 123, isProcessAlive: () => true });
    await lock.acquire();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      pid: 123,
    });
    await lock.release();
    await expect(access(path)).rejects.toThrow();
  });

  it('生存PIDのlockがあれば多重起動を拒否する', async () => {
    const { directory, path } = await lockFixture();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, '.state'));
    await writeFile(path, JSON.stringify({ pid: 456 }));
    const lock = new FileLock(path, {
      pid: 123,
      isProcessAlive: (pid) => pid === 456,
    });
    await expect(lock.acquire()).rejects.toMatchObject({ category: 'safety' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ pid: 456 });
  });

  it('死亡PIDのstale lockを回収して取得する', async () => {
    const { directory, path } = await lockFixture();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, '.state'));
    await writeFile(path, JSON.stringify({ pid: 456 }));
    const lock = new FileLock(path, { pid: 123, isProcessAlive: () => false });
    await lock.acquire();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      pid: 123,
    });
  });

  it('dry-runではlock directoryを作らない', async () => {
    const { directory, path } = await lockFixture();
    const lock = new FileLock(path, {
      pid: 123,
      isProcessAlive: () => true,
      dryRun: true,
    });
    await lock.acquire();
    await lock.release();
    expect(
      await import('node:fs/promises').then(({ readdir }) =>
        readdir(directory),
      ),
    ).toEqual([]);
  });
});
