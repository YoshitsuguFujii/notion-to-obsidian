import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPlannedPageAssets,
  planPageAssets,
  processPageAssets,
  type PlannedPageAssets,
} from '../src/assets/processor.js';
import { InfraError } from '../src/errors.js';
import type { BlockNode } from '../src/notion/blocks.js';
import type { AssetState } from '../src/storage/state-store.js';
import type {
  FileIdentityStat,
  HashFileHandle,
} from '../src/filesystem/hash-file-with-identity.js';

const pageId = '11111111-1111-4111-8111-111111111111';
const blockId = '22222222-2222-4222-8222-222222222222';
const url = 'https://files.example/photo.png?signature=temporary';
const blocks: BlockNode[] = [
  {
    block: {
      id: blockId,
      type: 'image',
      image: { type: 'file', file: { url }, caption: [] },
    },
    children: [],
  },
];
const assetAllowlists = {
  notionAssetAllowedContentTypes: ['image/png'],
  notionAssetAllowedExtensions: ['.png'],
  externalAssetAllowedContentTypes: ['image/png'],
  externalAssetAllowedExtensions: ['.png'],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function downloaded(value: string) {
  return async ({ destination }: { destination: string }) => {
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, value);
    return { size: Buffer.byteLength(value), contentHash: sha256(value) };
  };
}

function fallbackStat(
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

function fallbackHandle(options: {
  stats: FileIdentityStat[];
  content?: AsyncIterable<Buffer>;
}): HashFileHandle {
  let statIndex = 0;
  return {
    stat: () =>
      Promise.resolve(options.stats[statIndex++] ?? options.stats.at(-1)!),
    createReadStream: () =>
      options.content ?? Readable.from([Buffer.from('image')]),
    close: () => Promise.resolve(),
  };
}

describe('processPageAssets', () => {
  it('matched Notion assetをdownloadしてlocal URLへ書き換える', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const download = vi.fn(async ({ destination }: { destination: string }) => {
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, 'image');
      return {
        size: 5,
        contentHash: sha256('image'),
        contentType: 'image/png',
        etag: 'etag',
      };
    });
    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => undefined, download },
    );
    expect(result.markdown).toContain(
      `../_assets/${pageId}/${blockId}--photo.png`,
    );
    expect(result.assets).toEqual([
      expect.objectContaining({
        stableKey: `${pageId}:${blockId}`,
        etag: 'etag',
      }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(await readdir(join(root, `_assets/${pageId}`))).toEqual([
      `${blockId}--photo.png`,
    ]);
  });

  it('cache済みlocal assetは再downloadしない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const asset: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--photo.png`,
      originalName: 'photo.png',
      size: 5,
      etag: 'etag',
    };
    await mkdir(join(root, `_assets/${pageId}`), { recursive: true });
    await writeFile(join(root, asset.localPath), 'image');
    const download = vi.fn();
    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => asset, download },
    );
    expect(download).not.toHaveBeenCalled();
    expect(result.markdown).toContain('../_assets/');
  });

  it('remote metadataが保存されていなくてもlocal assetが存在すれば再downloadしない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const asset: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--photo.png`,
      originalName: 'photo.png',
    };
    await mkdir(join(root, `_assets/${pageId}`), { recursive: true });
    await writeFile(join(root, asset.localPath), 'image');
    const download = vi.fn();

    await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => asset, download },
    );

    expect(download).not.toHaveBeenCalled();
  });

  it('force指定時はlocal assetが存在しても再downloadする', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const asset: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--photo.png`,
      originalName: 'photo.png',
      size: 3,
      contentHash: sha256('old'),
    };
    await mkdir(join(root, `_assets/${pageId}`), { recursive: true });
    await writeFile(join(root, asset.localPath), 'old');
    const download = vi.fn(downloaded('new'));

    await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      { getAsset: () => asset, download },
    );

    expect(download).toHaveBeenCalledOnce();
  });

  it('download失敗時はremote URLを維持してwarningを返す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 1,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      {
        getAsset: () => undefined,
        download: () => Promise.reject(new Error('too large')),
      },
    );
    expect(result.markdown).toContain('https://files.example/photo.png');
    expect(result.markdown).not.toContain('signature=temporary');
    expect(result.assetStateUpdates).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        warningType: 'asset_download_failed',
        message:
          'Asset download failed; the remote URL was kept. The asset will be retried when the page changes or during a --full sync. Reason: too large',
      }),
    ]);
  });

  it('download失敗のwarningは署名query・認証情報・絶対パスをマスクする', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const sensitivePath = ['', 'private-home', 'vault', 'file.png'].join('/');
    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 1,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      {
        getAsset: () => undefined,
        download: () =>
          Promise.reject(
            new Error(
              `request https://files.example/photo.png?signature=secret failed with Bearer secret-token token=secret-value NOTION_TOKEN=notion-secret while opening '${sensitivePath}'`,
            ),
          ),
      },
    );

    const message = result.warnings[0]?.message ?? '';
    expect(message).toContain('https://files.example/photo.png?[REDACTED]');
    expect(message).toContain('Bearer [REDACTED]');
    expect(message).toContain('token=[REDACTED]');
    expect(message).toContain('[REDACTED_PATH]');
    expect(message).not.toContain('signature=secret');
    expect(message).not.toContain('secret-token');
    expect(message).not.toContain('secret-value');
    expect(message).not.toContain('notion-secret');
    expect(message).not.toContain(sensitivePath);
  });

  it('外部assetは設定無効時にdownloadしない', async () => {
    const external = 'https://external.example/image.png';
    const download = vi.fn();
    const result = await processPageAssets(
      {
        pageId,
        markdown: `![External](${external})`,
        pagePath: 'Page.md',
        blocks: [],
        managedRoot: '/tmp/managed',
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => undefined, download },
    );
    expect(download).not.toHaveBeenCalled();
    expect(result.markdown).toContain(external);
  });

  it('外部assetの取得失敗時はqueryを含むURLを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const external =
      'https://external.example/image.png?variant=preview#section';

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![External](${external})`,
        pagePath: 'Page.md',
        blocks: [],
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: true,
        apply: true,
      },
      {
        getAsset: () => undefined,
        download: () => Promise.reject(new Error('network unavailable')),
      },
    );

    expect(result.markdown).toContain(external);
    expect(result.assetStateUpdates).toEqual([]);
  });

  it('未検証cacheが存在してもlocal URLを採用しない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    await mkdir(join(root, localPath, '..'), { recursive: true });
    await writeFile(join(root, localPath), 'image');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
      cacheStatus: 'unverified',
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: false,
      },
      { getAsset: () => previous, download: downloaded('unused') },
    );

    expect(result.markdown).toContain('https://files.example/photo.png');
    expect(result.markdown).not.toContain(localPath);
    expect(result.assets).toEqual([]);
  });

  it('managed root内のsymlinkを経由する保存先へはdownloadしない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const outside = await mkdtemp(join(tmpdir(), 'notion-asset-outside-'));
    await symlink(outside, join(root, '_assets'));
    const download = vi.fn(downloaded('image'));

    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
        },
        { getAsset: () => undefined, download },
      ),
    ).rejects.toMatchObject({ category: 'safety' });

    expect(download).not.toHaveBeenCalled();
  });

  it('同じ内容の既存アセットは変更せず管理対象として取り込む', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    const target = join(root, localPath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'desired');
    const before = await stat(target);

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => undefined, download: downloaded('desired') },
    );

    expect(await readFile(target, 'utf8')).toBe('desired');
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
    expect(result.assets[0]).toMatchObject({
      localPath,
      contentHash: sha256('desired'),
    });
  });

  it('管理下の旧版アセットは新しい内容へ更新できる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    const target = join(root, localPath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'previous');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 8,
      contentHash: sha256('previous'),
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      { getAsset: () => previous, download: downloaded('desired') },
    );

    expect(await readFile(target, 'utf8')).toBe('desired');
    expect(result.assets[0]).toMatchObject({
      contentHash: sha256('desired'),
      originalName: 'photo.png',
      localPath,
    });
  });

  it('管理外の異なる内容が保存先にある場合は既存ファイルを変更しない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const target = join(root, `_assets/${pageId}/${blockId}--photo.png`);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'unmanaged');

    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
        },
        { getAsset: () => undefined, download: downloaded('desired') },
      ),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(target, 'utf8')).toBe('unmanaged');
  });

  it('内容の証明がない旧アセットと異なる保存内容は変更しない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    const target = join(root, localPath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'legacy');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
    };

    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
          force: true,
        },
        { getAsset: () => previous, download: downloaded('desired') },
      ),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(await readFile(target, 'utf8')).toBe('legacy');
  });

  it('内容の証明がない旧アセットでも新しい内容と一致すれば取り込む', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    const target = join(root, localPath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'desired');
    const before = await stat(target);
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      { getAsset: () => previous, download: downloaded('desired') },
    );

    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
    expect(result.assets[0]?.contentHash).toBe(sha256('desired'));
  });

  it('保存済みの識別情報と正準パスが一致しない場合は取得前に停止する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: `_assets/${pageId}/${blockId}--other.png`,
      originalName: 'photo.png',
    };
    const download = vi.fn(downloaded('desired'));

    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
          force: true,
        },
        { getAsset: () => previous, download },
      ),
    ).rejects.toMatchObject({ category: 'safety' });
    expect(download).not.toHaveBeenCalled();
  });

  it('添付名が変わっても管理下の保存先を維持して更新できる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    const target = join(root, localPath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'previous');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 8,
      contentHash: sha256('previous'),
    };
    const renamedBlocks: BlockNode[] = [
      {
        block: {
          id: blockId,
          type: 'image',
          image: {
            type: 'file',
            file: { url },
            name: 'diagram.png',
            caption: [],
          },
        },
        children: [],
      },
    ];

    const updated = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks: renamedBlocks,
        managedRoot: root,
        runId: 'run-1',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      { getAsset: () => previous, download: downloaded('desired') },
    );
    const stored = updated.assets[0]!;
    const download = vi.fn(downloaded('unused'));
    await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks: renamedBlocks,
        managedRoot: root,
        runId: 'run-2',
        now: '2026-07-12T01:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => stored, download },
    );

    expect(stored).toMatchObject({ originalName: 'photo.png', localPath });
    expect(await readFile(target, 'utf8')).toBe('desired');
    expect(download).not.toHaveBeenCalled();
  });

  it('一時ファイルの保存失敗はwarningにせずstorageとして停止する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
        },
        {
          getAsset: () => undefined,
          download: () =>
            Promise.reject(new InfraError('storage', 'temporary write failed')),
        },
      ),
    ).rejects.toMatchObject({ category: 'storage' });
  });

  it('通常ファイルではない保存先は読み込まずsafetyとして停止する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const target = join(root, `_assets/${pageId}/${blockId}--photo.png`);
    await mkdir(target, { recursive: true });

    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
        },
        { getAsset: () => undefined, download: downloaded('desired') },
      ),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('不正なURLはアセット単位のwarningとして扱う', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const malformed = 'relative.png';
    const malformedBlocks: BlockNode[] = [
      {
        block: {
          id: blockId,
          type: 'image',
          image: {
            type: 'file',
            file: { url: malformed },
            caption: [{ plain_text: 'Photo' }],
          },
        },
        children: [],
      },
    ];

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${malformed})`,
        pagePath: 'Notes/Page.md',
        blocks: malformedBlocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      { getAsset: () => undefined, download: downloaded('unused') },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ warningType: 'asset_download_failed' }),
    ]);
  });

  it('Notion assetがHTTP(S)以外のURLを持つ場合は元の参照を維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const nonHttpUrl = 'file:///example/photo.png';
    const nonHttpBlocks: BlockNode[] = [
      {
        block: {
          id: blockId,
          type: 'image',
          image: {
            type: 'file',
            file: { url: nonHttpUrl },
            caption: [],
          },
        },
        children: [],
      },
    ];

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${nonHttpUrl})`,
        pagePath: 'Notes/Page.md',
        blocks: nonHttpBlocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      {
        getAsset: () => undefined,
        download: () => Promise.reject(new Error('unsupported protocol')),
      },
    );

    expect(result.markdown).toContain(nonHttpUrl);
    expect(result.markdown).not.toContain('null/example/photo.png');
  });

  it('再取得に失敗したアセットは保存済みの内容を確認できない限りremote URLを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      {
        getAsset: () => previous,
        download: () => Promise.reject(new Error('network unavailable')),
      },
    );

    expect(result.markdown).toContain('https://files.example/photo.png');
    expect(result.markdown).not.toContain('signature=temporary');
    expect(result.assets).toEqual([]);
    expect(result.assetStateUpdates).toEqual([
      { ...previous, cacheStatus: 'unverified', lastSeenRunId: 'run' },
    ]);
    expect(result.warnings[0]?.message).toBe(
      'Asset download failed; the cached file could not be verified, so the remote URL was kept. The asset will be retried when the page changes or during a --full sync. Reason: network unavailable',
    );
  });

  it('再取得に失敗しても保存済みのhashとsizeに一致する通常ファイルはlocal URLを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    await mkdir(join(root, localPath, '..'), { recursive: true });
    await writeFile(join(root, localPath), 'image');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      {
        getAsset: () => previous,
        download: () => Promise.reject(new Error('network unavailable')),
      },
    );

    expect(result.markdown).toContain(`../${localPath}`);
    expect(result.assets).toEqual([{ ...previous, lastSeenRunId: 'run' }]);
    expect(result.assetStateUpdates).toEqual([
      { ...previous, cacheStatus: 'usable', lastSeenRunId: 'run' },
    ]);
    expect(result.warnings[0]?.message).toBe(
      'Asset download failed; the existing cached file was verified and kept. The asset will be retried when the page changes or during a --full sync. Reason: network unavailable',
    );
  });

  it.each([
    ['hashが保存されていない', { size: 5 }, 'image'],
    ['sizeが一致しない', { size: 4, contentHash: sha256('image') }, 'image'],
    ['hashが一致しない', { size: 5, contentHash: sha256('other') }, 'image'],
  ])(
    '%sアセットは再取得失敗時にremote URLを維持する',
    async (_condition, metadata, diskContent) => {
      const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
      const localPath = `_assets/${pageId}/${blockId}--photo.png`;
      await mkdir(join(root, localPath, '..'), { recursive: true });
      await writeFile(join(root, localPath), diskContent);
      const previous: AssetState = {
        stableKey: `${pageId}:${blockId}`,
        pageId,
        blockId,
        localPath,
        originalName: 'photo.png',
        ...metadata,
      };

      const result = await processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
          force: true,
        },
        {
          getAsset: () => previous,
          download: () => Promise.reject(new Error('network unavailable')),
        },
      );

      expect(result.markdown).toContain('https://files.example/photo.png');
      expect(result.markdown).not.toContain('signature=temporary');
      expect(result.assets).toEqual([]);
      expect(result.assetStateUpdates).toEqual([
        { ...previous, cacheStatus: 'unverified', lastSeenRunId: 'run' },
      ]);
    },
  );

  it('保存済みファイルを読み取れない場合は再取得失敗時にremote URLを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    await mkdir(join(root, localPath, '..'), { recursive: true });
    await writeFile(join(root, localPath), 'image');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      {
        getAsset: () => previous,
        download: () => Promise.reject(new Error('network unavailable')),
        fallbackFileSystem: {
          noFollowFlag: 1,
          open: () =>
            Promise.resolve(
              fallbackHandle({
                stats: [fallbackStat(), fallbackStat()],
                content: {
                  [Symbol.asyncIterator]() {
                    return {
                      next: () => Promise.reject(new Error('read unavailable')),
                    };
                  },
                },
              }),
            ),
        },
      },
    );

    expect(result.markdown).toContain('https://files.example/photo.png');
    expect(result.markdown).not.toContain('signature=temporary');
    expect(result.assets).toEqual([]);
    expect(result.assetStateUpdates).toEqual([
      { ...previous, cacheStatus: 'unverified', lastSeenRunId: 'run' },
    ]);
  });

  it.each([
    [
      '読取中にidentityが変化した',
      {
        open: () =>
          Promise.resolve(
            fallbackHandle({
              stats: [fallbackStat(), fallbackStat({ mtimeNs: 9n })],
            }),
          ),
      },
    ],
    [
      '読取後にpathが別のidentityを指した',
      {
        open: () =>
          Promise.resolve(
            fallbackHandle({ stats: [fallbackStat(), fallbackStat()] }),
          ),
        lstat: () => Promise.resolve(fallbackStat({ ino: 9n })),
      },
    ],
  ])(
    '%sアセットは未検証のlocal URLを採用せずsafetyとして停止する',
    async (_condition, fileSystem) => {
      const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
      const localPath = `_assets/${pageId}/${blockId}--photo.png`;
      await mkdir(join(root, localPath, '..'), { recursive: true });
      await writeFile(join(root, localPath), 'image');
      const previous: AssetState = {
        stableKey: `${pageId}:${blockId}`,
        pageId,
        blockId,
        localPath,
        originalName: 'photo.png',
        size: 5,
        contentHash: sha256('image'),
      };

      await expect(
        processPageAssets(
          {
            pageId,
            markdown: `![Photo](${url})`,
            pagePath: 'Notes/Page.md',
            blocks,
            managedRoot: root,
            runId: 'run',
            now: '2026-07-12T00:00:00.000Z',
            maximumBytes: 100,
            ...assetAllowlists,
            downloadExternalAssets: false,
            apply: true,
            force: true,
          },
          {
            getAsset: () => previous,
            download: () => Promise.reject(new Error('network unavailable')),
            fallbackFileSystem: { noFollowFlag: 1, ...fileSystem },
          },
        ),
      ).rejects.toMatchObject({ category: 'safety' });
    },
  );

  it('安全なfile openを利用できない場合はfallbackせずsafetyとして停止する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    await mkdir(join(root, localPath, '..'), { recursive: true });
    await writeFile(join(root, localPath), 'image');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    await expect(
      processPageAssets(
        {
          pageId,
          markdown: `![Photo](${url})`,
          pagePath: 'Notes/Page.md',
          blocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply: true,
          force: true,
        },
        {
          getAsset: () => previous,
          download: () => Promise.reject(new Error('network unavailable')),
          fallbackFileSystem: { noFollowFlag: undefined },
        },
      ),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('保存済みのhashがない場合は内容を読まずremote URLを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    await mkdir(join(root, localPath, '..'), { recursive: true });
    await writeFile(join(root, localPath), 'image');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      {
        getAsset: () => previous,
        download: () => Promise.reject(new Error('network unavailable')),
        fallbackFileSystem: {
          noFollowFlag: undefined,
          lstat: () => Promise.resolve(fallbackStat()),
          open: () => Promise.reject(new Error('content must not be read')),
        },
      },
    );

    expect(result.markdown).toContain('https://files.example/photo.png');
    expect(result.markdown).not.toContain('signature=temporary');
    expect(result.assets).toEqual([]);
    expect(result.assetStateUpdates).toEqual([
      { ...previous, cacheStatus: 'unverified', lastSeenRunId: 'run' },
    ]);
  });

  it('sizeが一致しない場合は内容を読まずremote URLを維持する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const localPath = `_assets/${pageId}/${blockId}--photo.png`;
    await mkdir(join(root, localPath, '..'), { recursive: true });
    await writeFile(join(root, localPath), 'different');
    const previous: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath,
      originalName: 'photo.png',
      size: 5,
      contentHash: sha256('image'),
    };

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
        force: true,
      },
      {
        getAsset: () => previous,
        download: () => Promise.reject(new Error('network unavailable')),
        fallbackFileSystem: {
          noFollowFlag: 1,
          open: () =>
            Promise.resolve(
              fallbackHandle({
                stats: [fallbackStat({ size: 9n })],
                content: {
                  [Symbol.asyncIterator]() {
                    throw new Error('content must not be read');
                  },
                },
              }),
            ),
        },
      },
    );

    expect(result.markdown).toContain('https://files.example/photo.png');
    expect(result.markdown).not.toContain('signature=temporary');
    expect(result.assets).toEqual([]);
    expect(result.assetStateUpdates).toEqual([
      { ...previous, cacheStatus: 'unverified', lastSeenRunId: 'run' },
    ]);
  });

  it.each(['symlink', 'directory'] as const)(
    '保存先が%sの場合はsafetyとして停止する',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
      const localPath = `_assets/${pageId}/${blockId}--photo.png`;
      const target = join(root, localPath);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'image');
      const previous: AssetState = {
        stableKey: `${pageId}:${blockId}`,
        pageId,
        blockId,
        localPath,
        originalName: 'photo.png',
        size: 5,
        contentHash: sha256('image'),
      };
      await expect(
        processPageAssets(
          {
            pageId,
            markdown: `![Photo](${url})`,
            pagePath: 'Notes/Page.md',
            blocks,
            managedRoot: root,
            runId: 'run',
            now: '2026-07-12T00:00:00.000Z',
            maximumBytes: 100,
            ...assetAllowlists,
            downloadExternalAssets: false,
            apply: true,
            force: true,
          },
          {
            getAsset: () => previous,
            download: async () => {
              await rm(target);
              if (kind === 'symlink') {
                await symlink(join(root, '..', 'outside.png'), target);
              } else {
                await mkdir(target);
              }
              throw new Error('network unavailable');
            },
          },
        ),
      ).rejects.toMatchObject({ category: 'safety' });
    },
  );

  it('同じアセットの取得結果が混在しても成功した内容を1件だけ採用する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const basePlan = await planPageAssets(
      {
        pageId,
        markdown: `![Photo](${url})`,
        pagePath: 'Notes/Page.md',
        blocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
      },
      { getAsset: () => undefined },
    );
    const duplicatePlan: PlannedPageAssets = {
      ...basePlan,
      downloads: [...basePlan.downloads, ...basePlan.downloads],
    };
    const apply = async (failureFirst: boolean) => {
      let attempt = 0;
      return applyPlannedPageAssets(
        {
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
        },
        duplicatePlan,
        {
          download: (request) => {
            const shouldFail = failureFirst ? attempt++ === 0 : attempt++ === 1;
            return shouldFail
              ? Promise.reject(new Error('network unavailable'))
              : downloaded('image')(request);
          },
        },
      );
    };

    const failureFirst = await apply(true);
    const successFirst = await apply(false);

    expect(failureFirst.assets).toHaveLength(1);
    expect(successFirst.assets).toEqual(failureFirst.assets);
    expect(failureFirst.assetStateUpdates).toEqual(
      successFirst.assetStateUpdates,
    );
    expect(failureFirst.assetStateUpdates).toEqual([
      expect.objectContaining({
        stableKey: `${pageId}:${blockId}`,
        cacheStatus: 'usable',
      }),
    ]);
    expect(failureFirst.markdown).toContain('../_assets/');
    expect(successFirst.markdown).toBe(failureFirst.markdown);
  });

  it('取得対象とno-download cacheが同じページにある場合はそれぞれのlocal URLとstateを採用する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const cachedUrl = 'https://files.example/cached.png';
    const fetchedUrl = 'https://files.example/fetched.png';
    const fetchedBlockId = '33333333-3333-4333-8333-333333333333';
    const cachedLocalPath = `_assets/${pageId}/${blockId}--cached.png`;
    const cached: AssetState = {
      stableKey: `${pageId}:${blockId}`,
      pageId,
      blockId,
      localPath: cachedLocalPath,
      originalName: 'cached.png',
      size: 6,
      contentHash: sha256('cached'),
    };
    await mkdir(join(root, cachedLocalPath, '..'), { recursive: true });
    await writeFile(join(root, cachedLocalPath), 'cached');
    const mixedBlocks: BlockNode[] = [
      {
        block: {
          id: blockId,
          type: 'image',
          image: {
            type: 'file',
            file: { url: cachedUrl },
            caption: [],
          },
        },
        children: [],
      },
      {
        block: {
          id: fetchedBlockId,
          type: 'image',
          image: {
            type: 'file',
            file: { url: fetchedUrl },
            caption: [],
          },
        },
        children: [],
      },
    ];
    const download = vi.fn(
      async (request: { url: URL; destination: string }) => {
        const { destination } = request;
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, 'fetched');
        return {
          size: 7,
          contentHash: sha256('fetched'),
        };
      },
    );

    const result = await processPageAssets(
      {
        pageId,
        markdown: `![Cached](${cachedUrl})\n\n![Fetched](${fetchedUrl})`,
        pagePath: 'Notes/Page.md',
        blocks: mixedBlocks,
        managedRoot: root,
        runId: 'run',
        now: '2026-07-12T00:00:00.000Z',
        maximumBytes: 100,
        ...assetAllowlists,
        downloadExternalAssets: false,
        apply: true,
      },
      {
        getAsset: (stableKey) =>
          stableKey === cached.stableKey ? cached : undefined,
        download,
      },
    );

    expect(result.markdown).toContain(`../${cachedLocalPath}`);
    expect(result.markdown).toContain(
      `../_assets/${pageId}/${fetchedBlockId}--fetched.png`,
    );
    expect(result.assets).toEqual(
      expect.arrayContaining([
        { ...cached, lastSeenRunId: 'run' },
        expect.objectContaining({ stableKey: `${pageId}:${fetchedBlockId}` }),
      ]),
    );
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0]?.[0].url.href).toBe(fetchedUrl);
  });

  it.each([
    { phase: '同期計画', apply: false },
    { phase: '同期適用', apply: true },
  ])(
    '$phaseでqueryだけ異なるURLが複数ブロックに対応する場合は警告を記録し安定参照を残す',
    async ({ apply }) => {
      const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
      const anotherBlockId = '33333333-3333-4333-8333-333333333333';
      const anotherUrl = 'https://files.example/photo.png?signature=other';
      const collidingBlocks: BlockNode[] = [
        ...blocks,
        {
          block: {
            id: anotherBlockId,
            type: 'image',
            image: { type: 'file', file: { url: anotherUrl }, caption: [] },
          },
          children: [],
        },
      ];

      const download = vi.fn(downloaded('image'));
      const result = await processPageAssets(
        {
          pageId,
          markdown: `![First](${url})\n\n![Second](${anotherUrl})`,
          pagePath: 'Notes/Page.md',
          blocks: collidingBlocks,
          managedRoot: root,
          runId: 'run',
          now: '2026-07-12T00:00:00.000Z',
          maximumBytes: 100,
          ...assetAllowlists,
          downloadExternalAssets: false,
          apply,
        },
        { getAsset: () => undefined, download },
      );

      expect(result.markdown).toContain(
        '![First](https://files.example/photo.png)',
      );
      expect(result.markdown).toContain(
        '![Second](https://files.example/photo.png)',
      );
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ warningType: 'asset_mapping_ambiguous' }),
      );
      expect(download).not.toHaveBeenCalled();
      await expect(access(join(root, '_assets'))).rejects.toThrow();
    },
  );
});
