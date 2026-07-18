import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { processPageAssets } from '../src/assets/processor.js';
import { InfraError } from '../src/errors.js';
import type { BlockNode } from '../src/notion/blocks.js';
import type { AssetState } from '../src/storage/state-store.js';

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
    expect(result.markdown).toContain(url);
    expect(result.warnings).toEqual([
      expect.objectContaining({ warningType: 'asset_download_failed' }),
    ]);
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
});
