import { access, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import type { RootCensus } from '../src/notion/census.js';
import { runSyncOrchestrator } from '../src/sync/orchestrator.js';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

const rootId = '11111111-1111-4111-8111-111111111111';
const directories: string[] = [];
const stores: SqliteStateStore[] = [];

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'notion-orchestrator-'));
  directories.push(vault);
  const store = new SqliteStateStore(':memory:');
  stores.push(store);
  const config: AppConfig = {
    notion: {
      roots: [{ pageId: rootId, localName: 'Notes' }],
      requestRatePerSecond: 2.5,
      concurrency: 2,
      token: 'secret-token',
    },
    obsidian: { vaultPath: vault, managedPath: join(vault, 'Mirror') },
    sync: {
      deletion_grace_runs: 2,
      maximum_trash_ratio: 0.2,
      maximum_trash_count: 50,
      download_external_assets: false,
      maximum_asset_size_mb: 100,
      notion_asset_allowed_content_types: ['image/png'],
      notion_asset_allowed_extensions: ['.png'],
      external_asset_allowed_content_types: ['image/png'],
      external_asset_allowed_extensions: ['.png'],
    },
    logging: { format: 'pretty', level: 'info' },
    state: { databasePath: join(vault, '.state', 'state.db') },
  };
  const census: RootCensus = {
    rootId,
    status: 'complete',
    deletionAllowed: true,
    resources: [
      {
        notionId: rootId,
        objectType: 'page',
        title: 'Remote title',
        parentType: 'workspace',
        rootId,
        lastEditedTime: '2026-07-12T00:00:00.000Z',
        inTrash: false,
        url: `https://www.notion.so/${rootId}`,
      },
    ],
    warnings: [],
  };
  const lock = {
    acquire: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  };
  return { vault, store, config, census, lock };
}

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runSyncOrchestrator', () => {
  it('初回CREATE後、同じ入力の2回目をUNCHANGEDとしてmtimeを維持する', async () => {
    const { store, config, census, lock } = await fixture();
    const dependencies = {
      store,
      lock,
      census: () => Promise.resolve(census),
      retrieveContent: () =>
        Promise.resolve({ markdown: '# Body\n', warnings: [], sidecars: [] }),
      now: () => '2026-07-12T01:00:00.000Z',
      runId: (() => {
        let value = 0;
        return () => `run-${++value}`;
      })(),
    };
    const first = await runSyncOrchestrator(config, {}, dependencies);
    const path = join(config.obsidian.managedPath, 'Notes.md');
    const before = (await stat(path)).mtimeMs;
    const second = await runSyncOrchestrator(config, {}, dependencies);
    expect(first.actions.map(({ type }) => type)).toContain('CREATE');
    expect(second.actions.map(({ type }) => type)).toContain('UNCHANGED');
    expect((await stat(path)).mtimeMs).toBe(before);
    expect(store.getLatestRun()?.counts).toMatchObject({ unchanged: 1 });
    expect(lock.acquire).toHaveBeenCalledTimes(2);
    expect(lock.release).toHaveBeenCalledTimes(2);
  });

  it('dry-runではfile・directory・DB runを作成しない', async () => {
    const { store, config, census, lock } = await fixture();
    const result = await runSyncOrchestrator(
      config,
      { dryRun: true },
      {
        store,
        lock,
        census: () => Promise.resolve(census),
        retrieveContent: () =>
          Promise.resolve({ markdown: '# Body\n', warnings: [], sidecars: [] }),
        now: () => '2026-07-12T01:00:00.000Z',
        runId: () => 'dry-run',
      },
    );
    expect(result.actions.map(({ type }) => type)).toContain('CREATE');
    await expect(access(config.obsidian.managedPath)).rejects.toThrow();
    expect(store.getLatestRun()).toBeUndefined();
  });

  it('page modeでは他resourceのTRASHを計画しない', async () => {
    const { store, config, census, lock } = await fixture();
    const result = await runSyncOrchestrator(
      config,
      { pageId: rootId },
      {
        store,
        lock,
        census: () => Promise.resolve(census),
        retrieveContent: () =>
          Promise.resolve({ markdown: '# Body\n', warnings: [], sidecars: [] }),
        now: () => '2026-07-12T01:00:00.000Z',
        runId: () => 'run-page',
      },
    );
    expect(result.actions.map(({ type }) => type)).not.toContain('TRASH');
  });

  it('page modeで親を持つpageのパスを解決し、対象pageだけを処理する', async () => {
    const { store, config, census, lock } = await fixture();
    const parentId = '22222222-2222-4222-8222-222222222222';
    const childId = '33333333-3333-4333-8333-333333333333';
    const nested: RootCensus = {
      ...census,
      resources: [
        ...census.resources,
        {
          notionId: parentId,
          objectType: 'page',
          title: 'Parent',
          parentId: rootId,
          parentType: 'page',
          rootId,
          lastEditedTime: '2026-07-12T00:00:00.000Z',
          inTrash: false,
          url: `https://www.notion.so/${parentId}`,
        },
        {
          notionId: childId,
          objectType: 'page',
          title: 'Child',
          parentId,
          parentType: 'page',
          rootId,
          lastEditedTime: '2026-07-12T00:00:00.000Z',
          inTrash: false,
          url: `https://www.notion.so/${childId}`,
        },
      ],
    };
    const retrieveContent = vi.fn(() =>
      Promise.resolve({ markdown: '# Child\n', warnings: [], sidecars: [] }),
    );

    const result = await runSyncOrchestrator(
      config,
      { pageId: childId },
      {
        store,
        lock,
        census: () => Promise.resolve(nested),
        retrieveContent,
        now: () => '2026-07-12T01:00:00.000Z',
        runId: () => 'run-nested-page',
      },
    );

    expect(retrieveContent).toHaveBeenCalledOnce();
    expect(retrieveContent).toHaveBeenCalledWith(childId);
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        notionId: childId,
        path: 'Notes/Parent/Child.md',
      }),
    );
    expect(result.actions).toHaveLength(1);
  });

  it('fullは保存済みresourceを再処理し、root filterは対象rootだけ取得する', async () => {
    const { store, config, census, lock } = await fixture();
    const censusFn = vi.fn(() => Promise.resolve(census));
    const deps = {
      store,
      lock,
      census: censusFn,
      retrieveContent: () =>
        Promise.resolve({ markdown: '# Body\n', warnings: [], sidecars: [] }),
      now: () => '2026-07-12T01:00:00.000Z',
      runId: (() => {
        let value = 0;
        return () => `run-full-${++value}`;
      })(),
    };
    await runSyncOrchestrator(config, {}, deps);
    const result = await runSyncOrchestrator(
      config,
      { full: true, rootId },
      deps,
    );
    expect(result.actions.map(({ type }) => type)).toContain('UPDATE');
    expect(censusFn).toHaveBeenLastCalledWith(rootId);
  });

  it('strictでwarningがあればpartial failureを返す', async () => {
    const { store, config, census, lock } = await fixture();
    const result = await runSyncOrchestrator(
      config,
      { strict: true },
      {
        store,
        lock,
        census: () => Promise.resolve(census),
        retrieveContent: () =>
          Promise.resolve({
            markdown: '# Body\n',
            warnings: [{ type: 'truncated', message: 'warning' }],
            sidecars: [],
          }),
        now: () => '2026-07-12T01:00:00.000Z',
        runId: () => 'run-strict',
      },
    );
    expect(result.partialFailure).toBe(true);
  });

  it('censusで検出したwarningを同期実行の状態に保存する', async () => {
    const { config, census, lock, store } = await fixture();
    const dependencies = {
      store,
      lock,
      census: () =>
        Promise.resolve({
          ...census,
          warnings: [
            {
              resourceId: rootId,
              type: 'search_missed_resource' as const,
              message: 'partial census',
            },
          ],
        }),
      retrieveContent: () =>
        Promise.resolve({ markdown: '# Body\n', warnings: [], sidecars: [] }),
      now: () => '2026-07-12T01:00:00.000Z',
      runId: () => 'run-census-warning',
    };

    const result = await runSyncOrchestrator(config, {}, dependencies);

    expect(store.listWarnings(result.runId)).toContainEqual(
      expect.objectContaining({
        resourceId: rootId,
        warningType: 'search_missed_resource',
        message: 'partial census',
      }),
    );
  });

  it('Data Sourceをindexとproperty付き行Markdownへ展開する', async () => {
    const { store, config, census, lock } = await fixture();
    const databaseId = '22222222-2222-4222-8222-222222222222';
    const rowId = '33333333-3333-4333-8333-333333333333';
    const withDatabase: RootCensus = {
      ...census,
      resources: [
        ...census.resources,
        {
          notionId: databaseId,
          objectType: 'database',
          title: 'Tasks',
          parentId: rootId,
          parentType: 'page',
          rootId,
          lastEditedTime: '2026-07-12T00:00:00.000Z',
          inTrash: false,
          url: `https://www.notion.so/${databaseId}`,
          dataSourceId: 'source-id',
        },
      ],
    };
    const result = await runSyncOrchestrator(
      config,
      {},
      {
        store,
        lock,
        census: () => Promise.resolve(withDatabase),
        fetchDataSourceRows: () =>
          Promise.resolve([
            {
              object: 'page',
              id: rowId,
              url: `https://www.notion.so/${rowId}`,
              last_edited_time: '2026-07-12T00:00:00.000Z',
              properties: {
                Name: { type: 'title', title: [{ plain_text: 'First task' }] },
                Status: { type: 'status', status: { name: 'Done' } },
              },
            },
          ]),
        retrieveContent: () =>
          Promise.resolve({
            markdown: '# Row body\n',
            warnings: [],
            sidecars: [],
          }),
        now: () => '2026-07-12T01:00:00.000Z',
        runId: () => 'run-data-source',
      },
    );
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          notionId: databaseId,
          path: 'Notes/Tasks/_index.md',
        }),
        expect.objectContaining({
          notionId: rowId,
          path: 'Notes/Tasks/First task.md',
        }),
      ]),
    );
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(
          join(config.obsidian.managedPath, 'Notes', 'Tasks', '_index.md'),
          'utf8',
        ),
      ),
    ).toContain('| Status | status |');
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(
          join(config.obsidian.managedPath, 'Notes', 'Tasks', 'First task.md'),
          'utf8',
        ),
      ),
    ).toContain('Status: Done');
  });

  it('assetをdownload・URL rewrite・DB保存し、2回目はcacheで再取得しない', async () => {
    const { store, config, census, lock } = await fixture();
    const blockId = '44444444-4444-4444-8444-444444444444';
    const assetUrl = 'https://files.example/photo.png?signature=temporary';
    const downloadAsset = vi.fn(
      async ({ destination }: { destination: string }) => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, 'image');
        return { size: 5, contentType: 'image/png', etag: 'etag' };
      },
    );
    const dependencies = {
      store,
      lock,
      census: () => Promise.resolve(census),
      retrieveContent: () =>
        Promise.resolve({
          markdown: `![Photo](${assetUrl})`,
          warnings: [],
          sidecars: [],
        }),
      retrieveBlocks: () =>
        Promise.resolve([
          {
            block: {
              id: blockId,
              type: 'image',
              image: { type: 'file', file: { url: assetUrl }, caption: [] },
            },
            children: [],
          },
        ]),
      downloadAsset,
      now: () => '2026-07-12T01:00:00.000Z',
      runId: (() => {
        let value = 0;
        return () => `run-asset-${++value}`;
      })(),
    };
    await runSyncOrchestrator(config, {}, dependencies);
    const markdown = await import('node:fs/promises').then(({ readFile }) =>
      readFile(join(config.obsidian.managedPath, 'Notes.md'), 'utf8'),
    );
    expect(markdown).toContain(`_assets/${rootId}/${blockId}--photo.png`);
    expect(store.getAsset(`${rootId}:${blockId}`)).toMatchObject({
      etag: 'etag',
    });
    const second = await runSyncOrchestrator(config, {}, dependencies);
    expect(second.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: rootId }),
    );
    expect(downloadAsset).toHaveBeenCalledTimes(1);
  });
});
