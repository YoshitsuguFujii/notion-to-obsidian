import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  hashFileWithIdentity,
  type FileIdentityStat,
  type HashFileHandle,
} from '../src/filesystem/hash-file-with-identity.js';

const run = promisify(execFile);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileStat(
  overrides: Partial<Omit<FileIdentityStat, 'isFile'>> = {},
): FileIdentityStat {
  return {
    dev: 1n,
    ino: 2n,
    size: 5n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    isFile: () => true,
    ...overrides,
  };
}

function stream(value: string): AsyncIterable<Buffer> {
  return Readable.from([Buffer.from(value)]);
}

function handle(options: {
  stats: FileIdentityStat[];
  content?: AsyncIterable<Buffer>;
  closeError?: Error;
}): HashFileHandle {
  let statIndex = 0;
  return {
    stat: () =>
      Promise.resolve(options.stats[statIndex++] ?? options.stats.at(-1)!),
    createReadStream: () => options.content ?? stream('image'),
    close: () =>
      options.closeError
        ? Promise.reject(options.closeError)
        : Promise.resolve(),
  };
}

describe('hashFileWithIdentity', () => {
  it('通常ファイルを同じfile handleから読み取りhashとidentityを返す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-identity-hash-'));
    const target = join(root, 'asset.bin');
    await writeFile(target, 'image');

    const result = await hashFileWithIdentity(target, [5]);

    expect(result).toMatchObject({ kind: 'hashed', hash: sha256('image') });
  });

  it('検査中に予期しない例外が発生してもfile handleを閉じる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-identity-hash-'));
    const target = join(root, 'asset.bin');
    await writeFile(target, 'image');
    let openedHandle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      await expect(
        hashFileWithIdentity(target, [Number.NaN], {
          open: async (path, flags) => {
            openedHandle = await open(path, flags);
            return openedHandle;
          },
        }),
      ).rejects.toThrow(RangeError);

      await expect(openedHandle?.stat()).rejects.toMatchObject({
        code: 'EBADF',
      });
    } finally {
      await openedHandle?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sizeが一致し得ないファイルは内容を読まずに判定する', async () => {
    const stable = fileStat({ size: 9n });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () =>
        Promise.resolve(
          handle({
            stats: [stable],
            content: {
              [Symbol.asyncIterator]() {
                throw new Error('content must not be read');
              },
            },
          }),
        ),
    });

    expect(result).toEqual({ kind: 'size-mismatch' });
  });

  it('読取中に同じinodeのmetadataが変化した場合は競合として返す', async () => {
    const before = fileStat();
    const after = fileStat({ mtimeNs: 10n });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () => Promise.resolve(handle({ stats: [before, after] })),
    });

    expect(result).toEqual({ kind: 'changed', reason: 'during-read' });
  });

  it('読取後にpathが別のidentityを指す場合は競合として返す', async () => {
    const stable = fileStat();
    const replaced = fileStat({ ino: 9n });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () => Promise.resolve(handle({ stats: [stable, stable] })),
      lstat: () => Promise.resolve(replaced),
    });

    expect(result).toEqual({ kind: 'changed', reason: 'path-after-read' });
  });

  it('読取後にpathが消えた場合は不在ではなく競合として返す', async () => {
    const stable = fileStat();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () => Promise.resolve(handle({ stats: [stable, stable] })),
      lstat: () => Promise.reject(missing),
    });

    expect(result).toEqual({ kind: 'changed', reason: 'path-after-read' });
  });

  it('競合を確認した後のclose失敗は競合結果を上書きしない', async () => {
    const before = fileStat();
    const after = fileStat({ ctimeNs: 10n });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () =>
        Promise.resolve(
          handle({
            stats: [before, after],
            closeError: new Error('close failed'),
          }),
        ),
    });

    expect(result).toEqual({ kind: 'changed', reason: 'during-read' });
  });

  it('安定した読取後のclose失敗はI/O失敗として返す', async () => {
    const stable = fileStat();
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () =>
        Promise.resolve(
          handle({
            stats: [stable, stable],
            closeError: new Error('close failed'),
          }),
        ),
      lstat: () => Promise.resolve(stable),
    });

    expect(result).toMatchObject({ kind: 'io-error', phase: 'close' });
  });

  it('size不一致の判定後にcloseできない場合はI/O失敗として返す', async () => {
    const stable = fileStat({ size: 9n });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () =>
        Promise.resolve(
          handle({
            stats: [stable],
            closeError: new Error('close failed'),
          }),
        ),
    });

    expect(result).toMatchObject({ kind: 'io-error', phase: 'close' });
  });

  it.each([
    [
      '読取前のidentity取得',
      'stat-before',
      {
        stat: () => Promise.reject(new Error('stat failed')),
        createReadStream: () => stream('image'),
        close: () => Promise.resolve(),
      },
      undefined,
    ],
    [
      'stream読取',
      'read',
      {
        stat: () => Promise.resolve(fileStat()),
        createReadStream: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.reject(new Error('read failed')),
            };
          },
        }),
        close: () => Promise.resolve(),
      },
      undefined,
    ],
    [
      '読取後のidentity取得',
      'stat-after',
      (() => {
        let statIndex = 0;
        return {
          stat: () =>
            statIndex++ === 0
              ? Promise.resolve(fileStat())
              : Promise.reject(new Error('stat failed')),
          createReadStream: () => stream('image'),
          close: () => Promise.resolve(),
        };
      })(),
      undefined,
    ],
    [
      '読取後のpath照合',
      'path-stat-after',
      handle({ stats: [fileStat(), fileStat()] }),
      () => Promise.reject(new Error('lstat failed')),
    ],
  ] as const)(
    '%sに失敗した場合はphaseを保ったI/O失敗として返す',
    async (_condition, phase, opened, inspectPath) => {
      const result = await hashFileWithIdentity('asset.bin', [5], {
        noFollowFlag: 1,
        open: () => Promise.resolve(opened),
        ...(inspectPath ? { lstat: inspectPath } : {}),
      });

      expect(result).toMatchObject({ kind: 'io-error', phase });
    },
  );

  it('安全なopenを利用できない環境では検査を続行しない', async () => {
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: undefined,
      open: () => Promise.reject(new Error('open must not be attempted')),
    });

    expect(result).toEqual({ kind: 'unsupported-no-follow' });
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])(
    '%sで安全なopenが拒否された場合は非対応として返す',
    async (code) => {
      const result = await hashFileWithIdentity('asset.bin', [5], {
        noFollowFlag: 1,
        open: () =>
          Promise.reject(Object.assign(new Error('unsupported'), { code })),
      });

      expect(result).toEqual({ kind: 'unsupported-no-follow' });
    },
  );

  it('未知のopen失敗は通常のI/O失敗として返す', async () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    const result = await hashFileWithIdentity('asset.bin', [5], {
      noFollowFlag: 1,
      open: () => Promise.reject(failure),
    });

    expect(result).toMatchObject({ kind: 'io-error', phase: 'open' });
  });

  it('symlinkは通常ファイルとして読まない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-identity-hash-'));
    const source = join(root, 'source.bin');
    const target = join(root, 'target.bin');
    await writeFile(source, 'image');
    await symlink(source, target);

    const result = await hashFileWithIdentity(target, [5]);

    expect(result).toEqual({ kind: 'not-regular', reason: 'symlink' });
  });

  it('directoryは通常ファイルとして読まない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-identity-hash-'));

    const result = await hashFileWithIdentity(root, [5]);

    expect(result).toEqual({ kind: 'not-regular', reason: 'other' });
  });

  it('writerがいないFIFOでも待ち続けず通常ファイルではないと返す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-identity-hash-'));
    const target = join(root, 'asset.pipe');
    await run('mkfifo', [target]);
    try {
      const result = await hashFileWithIdentity(target, [5]);

      expect(result).toEqual({ kind: 'not-regular', reason: 'other' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
