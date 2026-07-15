import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { processPageAssets } from '../src/assets/processor.js';
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

describe('processPageAssets', () => {
  it('matched Notion assetをdownloadしてlocal URLへ書き換える', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-asset-process-'));
    const download = vi.fn(async ({ destination }: { destination: string }) => {
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, 'image');
      return { size: 5, contentType: 'image/png', etag: 'etag' };
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
    };
    await mkdir(join(root, `_assets/${pageId}`), { recursive: true });
    await writeFile(join(root, asset.localPath), 'old');
    const download = vi.fn(() => Promise.resolve({ size: 3 }));

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
    const download = vi.fn(() => Promise.resolve({ size: 5 }));

    const result = await processPageAssets(
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
    );

    expect(download).not.toHaveBeenCalled();
    expect(result.markdown).toContain(url);
    expect(result.warnings).toEqual([
      expect.objectContaining({ warningType: 'asset_download_failed' }),
    ]);
  });
});
