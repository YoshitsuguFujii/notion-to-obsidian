import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type {
  DownloadRequest,
  DownloadResult,
} from '../../src/assets/http-downloader.js';
import type { AppConfig } from '../../src/config/index.js';
import { retrieveBlockTree } from '../../src/notion/blocks.js';
import { censusRoot } from '../../src/notion/census.js';
import { fetchDataSourceRows } from '../../src/notion/data-sources.js';
import { retrieveMarkdownWithFallback } from '../../src/notion/markdown.js';
import type { NotionClient } from '../../src/notion/types.js';
import { SqliteStateStore } from '../../src/storage/sqlite-store.js';
import type { StateStore } from '../../src/storage/state-store.js';
import { reconcileCrash } from '../../src/sync/reconcile-crash.js';
import {
  runSyncOrchestrator,
  type SyncOptions,
} from '../../src/sync/orchestrator.js';

export const ROOT_ID = '11111111-1111-4111-8111-111111111111';
export const ROOT_B_ID = '66666666-6666-4666-8666-666666666666';
export const PARENT_A_ID = '22222222-2222-4222-8222-222222222222';
export const PARENT_B_ID = '33333333-3333-4333-8333-333333333333';
export const CHILD_ID = '44444444-4444-4444-8444-444444444444';
export const SIBLING_ID = '55555555-5555-4555-8555-555555555555';

export interface MockPage {
  id: string;
  title: string;
  parentId?: string;
  lastEditedTime?: string;
  markdown?: string;
  inTrash?: boolean;
  blocks?: Array<Record<string, unknown>>;
  markdownTruncated?: boolean;
  unknownBlockIds?: string[];
  discoverableAsChild?: boolean;
}

interface MockDataSource {
  id: string;
  name: string;
  databaseId: string;
  rows: MockPage[];
}

function cursorPage(results: unknown[]) {
  return { results, has_more: false, next_cursor: null };
}

function pageResponse(page: MockPage) {
  return {
    object: 'page',
    id: page.id,
    parent: page.parentId
      ? { type: 'page_id', page_id: page.parentId }
      : { type: 'workspace', workspace: true },
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: page.title }],
      },
    },
    last_edited_time: page.lastEditedTime ?? '2026-07-12T00:00:00.000Z',
    in_trash: page.inTrash ?? false,
    archived: page.inTrash ?? false,
    url: `https://www.notion.so/${page.id}`,
  };
}

export interface SyncHarness {
  vault: string;
  managedRoot: string;
  config: AppConfig;
  store: SqliteStateStore;
  client: NotionClient;
  setPages(pages: MockPage[]): void;
  setNow(value: string): void;
  failRoot(value: boolean): void;
  failSearch(value: boolean): void;
  sync(options?: SyncOptions): ReturnType<typeof runSyncOrchestrator>;
  close(): Promise<void>;
}

export async function createSyncHarness(
  initialPages: MockPage[],
  harnessOptions: {
    downloadAsset?: (request: DownloadRequest) => Promise<DownloadResult>;
    dataSources?: MockDataSource[];
    blockChildren?: Readonly<Record<string, Array<Record<string, unknown>>>>;
    storeWrapper?: (store: SqliteStateStore) => StateStore;
  } = {},
): Promise<SyncHarness> {
  const vault = await mkdtemp(join(tmpdir(), 'notion-e2e-'));
  const managedRoot = join(vault, 'Mirror');
  const store = new SqliteStateStore(join(vault, 'state.db'));
  const stateStore = harnessOptions.storeWrapper?.(store) ?? store;
  let pages = new Map(initialPages.map((page) => [page.id, page]));
  let rootFailure = false;
  let searchFailure = false;
  let run = 0;
  let now = '2026-07-12T01:00:00.000Z';
  const client: NotionClient = {
    retrievePage: vi.fn((pageId: string) => {
      if (rootFailure && pageId === ROOT_ID)
        return Promise.reject(new Error('root unavailable'));
      const page = pages.get(pageId);
      return page
        ? Promise.resolve(pageResponse(page))
        : Promise.reject(
            Object.assign(new Error('not found'), { status: 404 }),
          );
    }),
    retrieveDatabase: vi.fn((databaseId: string) => {
      const dataSources = (harnessOptions.dataSources ?? []).filter(
        (dataSource) => dataSource.databaseId === databaseId,
      );
      return Promise.resolve({
        id: databaseId,
        data_sources: dataSources.map(({ id, name }) => ({ id, name })),
      });
    }),
    retrieveMarkdown: vi.fn((pageId: string) => {
      const page =
        pages.get(pageId) ??
        harnessOptions.dataSources
          ?.flatMap(({ rows }) => rows)
          .find(({ id }) => id === pageId);
      return page
        ? Promise.resolve({
            markdown: page.markdown ?? `# ${page.title}\n`,
            truncated: page.markdownTruncated ?? false,
            unknown_block_ids: page.unknownBlockIds ?? [],
          })
        : Promise.reject(
            Object.assign(new Error('not found'), { status: 404 }),
          );
    }),
    listBlockChildren: vi.fn((parentId: string) => {
      const children = [...pages.values()]
        .filter(
          (page) =>
            page.parentId === parentId && page.discoverableAsChild !== false,
        )
        .map((page) => ({
          id: page.id,
          type: 'child_page',
          child_page: { title: page.title },
          parent: { type: 'page_id', page_id: parentId },
          last_edited_time: page.lastEditedTime ?? '2026-07-12T00:00:00.000Z',
          in_trash: page.inTrash ?? false,
          archived: page.inTrash ?? false,
          url: `https://www.notion.so/${page.id}`,
        }));
      return Promise.resolve(
        cursorPage([
          ...children,
          ...(pages.get(parentId)?.blocks ?? []),
          ...(harnessOptions.blockChildren?.[parentId] ?? []),
        ]),
      );
    }),
    queryDataSource: vi.fn((dataSourceId: string) => {
      const rows =
        harnessOptions.dataSources?.find(({ id }) => id === dataSourceId)
          ?.rows ?? [];
      return Promise.resolve(cursorPage(rows.map(pageResponse)));
    }),
    search: vi.fn(() =>
      searchFailure
        ? Promise.reject(new Error('search unavailable'))
        : Promise.resolve(cursorPage([])),
    ),
  };
  const config: AppConfig = {
    notion: {
      roots: [{ pageId: ROOT_ID, localName: 'Notes' }],
      requestRatePerSecond: 2.5,
      concurrency: 2,
      token: 'e2e-placeholder-token',
    },
    obsidian: { vaultPath: vault, managedPath: managedRoot },
    sync: {
      deletion_grace_runs: 2,
      maximum_trash_ratio: 1,
      maximum_trash_count: 50,
      download_external_assets: false,
      maximum_asset_size_mb: 100,
      notion_asset_allowed_content_types: [
        'image/png',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/zip',
        'video/quicktime',
      ],
      notion_asset_allowed_extensions: ['.png', '.docx', '.zip', '.mov'],
      external_asset_allowed_content_types: ['image/png'],
      external_asset_allowed_extensions: ['.png'],
    },
    logging: { format: 'pretty', level: 'info' },
    state: { databasePath: join(vault, 'state.db') },
  };
  const lock = {
    acquire: () => Promise.resolve(),
    release: () => Promise.resolve(),
  };
  return {
    vault,
    managedRoot,
    config,
    store,
    client,
    setPages(nextPages) {
      pages = new Map(nextPages.map((page) => [page.id, page]));
    },
    setNow(value) {
      now = value;
    },
    failRoot(value) {
      rootFailure = value;
    },
    failSearch(value) {
      searchFailure = value;
    },
    sync(options = {}) {
      return runSyncOrchestrator(config, options, {
        store: stateStore,
        lock,
        census: (rootId) => censusRoot(client, rootId),
        retrieveContent: (pageId) =>
          retrieveMarkdownWithFallback(client, pageId),
        retrieveBlocks: (pageId) => retrieveBlockTree(client, pageId),
        fetchDataSourceRows: (dataSourceId) =>
          fetchDataSourceRows(client, dataSourceId),
        downloadAsset:
          harnessOptions.downloadAsset ??
          (async ({ destination }) => {
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, 'asset-content');
            return {
              size: 13,
              contentHash:
                '06692694f09c22857b9c8d83e5b0389bdecdf754c011778af2f72a75b8726fb4',
              contentType: 'image/png',
              etag: 'e2e-etag',
            };
          }),
        now: () => now,
        runId: () => `e2e-run-${++run}`,
        recover: (dryRun) =>
          reconcileCrash({ managedRoot, store, dryRun }).then(() => undefined),
      });
    },
    async close() {
      store.close();
      await rm(vault, { recursive: true, force: true });
    },
  };
}

export function rootPage(overrides: Partial<MockPage> = {}): MockPage {
  return { id: ROOT_ID, title: 'Root', markdown: '# Root\n', ...overrides };
}

export function childPage(overrides: Partial<MockPage> = {}): MockPage {
  return {
    id: CHILD_ID,
    title: 'Child',
    parentId: ROOT_ID,
    markdown: '# Child\n',
    ...overrides,
  };
}
