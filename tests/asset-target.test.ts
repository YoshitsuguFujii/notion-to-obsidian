import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  commitAssetDownload,
  inspectAssetTargetForPlan,
  type PlannedAssetTarget,
} from '../src/assets/target.js';
import type {
  FileIdentityStat,
  HashFileHandle,
  HashFileWithIdentityDependencies,
} from '../src/filesystem/hash-file-with-identity.js';
import type { AssetState } from '../src/storage/state-store.js';

const pageId = '11111111-1111-4111-8111-111111111111';
const blockId = '22222222-2222-4222-8222-222222222222';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stream(value: string): AsyncIterable<Buffer> {
  return Readable.from([Buffer.from(value)]);
}

function fakeHandle(
  stats: FileIdentityStat[],
  content: string,
): HashFileHandle {
  let statIndex = 0;
  return {
    stat: () => Promise.resolve(stats[statIndex++] ?? stats.at(-1)!),
    createReadStream: () => stream(content),
    close: () => Promise.resolve(),
  };
}

function withIdentity(
  source: FileIdentityStat,
  overrides: Partial<Omit<FileIdentityStat, 'isFile'>>,
): FileIdentityStat {
  return { ...source, ...overrides, isFile: () => true };
}

function plannedTarget(
  absolutePath: string,
  previous?: AssetState,
): PlannedAssetTarget {
  const localPath = `_assets/${pageId}/${blockId}--photo.png`;
  return {
    stableKey: `${pageId}:${blockId}`,
    pageId,
    blockId,
    localPath,
    absolutePath,
    originalName: 'photo.png',
    previous,
  };
}

async function identity(path: string): Promise<FileIdentityStat> {
  return lstat(path, { bigint: true });
}

describe('inspectAssetTargetForPlan', () => {
  it('hash読取中にidentityが変化した場合はApplyでの再検査へ延期する', async () => {
    const stable = withIdentity(
      {
        dev: 1n,
        ino: 2n,
        size: 5n,
        mtimeNs: 3n,
        ctimeNs: 4n,
        isFile: () => true,
      },
      {},
    );
    const changed = withIdentity(stable, { mtimeNs: 9n });
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--photo.png`,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    const result = await inspectAssetTargetForPlan(
      plannedTarget('asset.bin', previous),
      {
        noFollowFlag: 1,
        open: () => Promise.resolve(fakeHandle([stable, changed], 'image')),
      },
    );

    expect(result).toBe('deferred');
  });

  it('安全なfile openを利用できない場合はsafetyとして停止する', async () => {
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--photo.png`,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    await expect(
      inspectAssetTargetForPlan(plannedTarget('asset.bin', previous), {
        noFollowFlag: undefined,
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('通常の読取失敗はstorageとして停止する', async () => {
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--photo.png`,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });

    await expect(
      inspectAssetTargetForPlan(plannedTarget('asset.bin', previous), {
        noFollowFlag: 1,
        open: () => Promise.reject(denied),
      }),
    ).rejects.toMatchObject({ category: 'storage' });
  });
});

describe('commitAssetDownload', () => {
  it.each([
    ['同じ内容のlocal採用', 'desired', undefined],
    [
      '管理下の内容更新',
      'previous',
      {
        stableKey: `${pageId}:${blockId}`,
        pageId,
        blockId,
        localPath: `_assets/${pageId}/${blockId}--photo.png`,
        originalName: 'photo.png',
        size: 8,
        contentHash: sha256('previous'),
      } satisfies AssetState,
    ],
  ])(
    '%sの直前にpathが変化した場合はtargetを保持して停止する',
    async (_condition, diskContent, previous) => {
      const root = await mkdtemp(join(tmpdir(), 'asset-target-'));
      const targetPath = join(root, 'asset.bin');
      const temporaryPath = join(root, 'download.tmp');
      await writeFile(targetPath, diskContent);
      await writeFile(temporaryPath, 'desired');
      const stable = await identity(targetPath);
      const replaced = withIdentity(stable, { ino: stable.ino + 1n });
      let pathInspection = 0;
      const fileSystem: HashFileWithIdentityDependencies = {
        noFollowFlag: 1,
        open: () => Promise.resolve(fakeHandle([stable, stable], diskContent)),
        lstat: () =>
          Promise.resolve(pathInspection++ === 0 ? stable : replaced),
      };

      await expect(
        commitAssetDownload(
          {
            target: plannedTarget(targetPath, previous),
            temporaryPath,
            desiredHash: sha256('desired'),
            desiredSize: 7,
          },
          fileSystem,
        ),
      ).rejects.toMatchObject({ category: 'safety' });

      expect(await readFile(targetPath, 'utf8')).toBe(diskContent);
    },
  );

  it('確定直前にpathを検査できない場合はtargetを保持してstorageとして停止する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asset-target-'));
    const targetPath = join(root, 'asset.bin');
    const temporaryPath = join(root, 'download.tmp');
    await writeFile(targetPath, 'desired');
    await writeFile(temporaryPath, 'desired');
    const stable = await identity(targetPath);
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    let pathInspection = 0;

    await expect(
      commitAssetDownload(
        {
          target: plannedTarget(targetPath),
          temporaryPath,
          desiredHash: sha256('desired'),
          desiredSize: 7,
        },
        {
          noFollowFlag: 1,
          open: () => Promise.resolve(fakeHandle([stable, stable], 'desired')),
          lstat: () =>
            pathInspection++ === 0
              ? Promise.resolve(stable)
              : Promise.reject(denied),
        },
      ),
    ).rejects.toMatchObject({ category: 'storage' });

    expect(await readFile(targetPath, 'utf8')).toBe('desired');
  });
});
