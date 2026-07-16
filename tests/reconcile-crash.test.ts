import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileCrash } from '../src/sync/reconcile-crash.js';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

const notionId = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const stores: SqliteStateStore[] = [];

function markdown(hash = 'new-hash'): string {
  return `---\nmanaged_by: notion-to-obsidian\nnotion_id: ${notionId}\ncontent_hash: ${hash}\n---\nBody\n`;
}

async function fixture(
  options: { localPath?: string; expectedPath?: string; hash?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'notion-recovery-'));
  roots.push(root);
  const store = new SqliteStateStore(':memory:');
  stores.push(store);
  store.upsertRoot({
    rootPageId: 'root-id',
    localName: 'Root',
    status: 'complete',
  });
  store.upsertResource({
    notionId,
    objectType: 'page',
    rootId: 'root-id',
    title: 'Page',
    localPath: options.localPath ?? 'Old/Page.md',
    expectedPath: options.expectedPath ?? options.localPath ?? 'Old/Page.md',
    resolvedFilename: 'Page',
    lastEditedTime: '2026-07-12T00:00:00.000Z',
    contentHash: options.hash ?? 'old-hash',
    inTrash: false,
    status: 'active',
    missingCount: 0,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  });
  return { root, store };
}

async function put(
  root: string,
  path: string,
  content = markdown(),
): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('reconcileCrash', () => {
  it('unfinished runを検出する', async () => {
    const { root, store } = await fixture();
    store.beginRun({
      runId: 'unfinished',
      startedAt: '2026-07-12T00:00:00.000Z',
      mode: 'full',
      configHash: 'config',
      apiVersion: '2026-03-11',
      toolVersion: '0.1.0',
      transformVersion: '1',
    });
    expect(
      (await reconcileCrash({ managedRoot: root, store })).findings,
    ).toContainEqual({ type: 'unfinished_run', runId: 'unfinished' });
  });

  it('確定fileのhashへDBを合わせる', async () => {
    const { root, store } = await fixture();
    await put(root, 'Old/Page.md');
    expect(
      (await reconcileCrash({ managedRoot: root, store })).findings,
    ).toContainEqual({
      type: 'content_relinked',
      notionId,
      path: 'Old/Page.md',
    });
    expect(store.getResource(notionId)?.contentHash).toBe('new-hash');
  });

  it('MOVE後のnew pathへDBを合わせる', async () => {
    const { root, store } = await fixture({ expectedPath: 'New/Page.md' });
    await put(root, 'New/Page.md');
    expect(
      (await reconcileCrash({ managedRoot: root, store })).findings,
    ).toContainEqual({ type: 'move_relinked', notionId, path: 'New/Page.md' });
    expect(store.getResource(notionId)?.localPath).toBe('New/Page.md');
  });

  it('trash内のfileに合わせてDBをtombstoneにする', async () => {
    const { root, store } = await fixture();
    await put(root, '.trash/2026-07-12/Old/Page.md');
    expect(
      (
        await reconcileCrash({
          managedRoot: root,
          store,
          now: '2026-07-12T01:00:00.000Z',
        })
      ).findings,
    ).toContainEqual({
      type: 'trash_relinked',
      notionId,
      path: '.trash/2026-07-12/Old/Page.md',
    });
    expect(store.getResource(notionId)).toMatchObject({
      status: 'tombstoned',
      inTrash: true,
      trashReason: 'manual_reconcile',
    });
  });

  it('DBのfileが存在しなければmissing候補として報告するだけにする', async () => {
    const { root, store } = await fixture();
    expect(
      (await reconcileCrash({ managedRoot: root, store })).findings,
    ).toContainEqual({ type: 'missing_file', notionId, path: 'Old/Page.md' });
    expect(store.getResource(notionId)?.status).toBe('active');
  });

  it('DB未登録の管理marker付きfileを孤児として報告し変更しない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-recovery-'));
    roots.push(root);
    const store = new SqliteStateStore(':memory:');
    stores.push(store);
    await put(root, 'Orphan.md');
    expect(
      (await reconcileCrash({ managedRoot: root, store })).findings,
    ).toContainEqual({
      type: 'orphan_managed_file',
      notionId,
      path: 'Orphan.md',
    });
    expect(await readFile(join(root, 'Orphan.md'), 'utf8')).toBe(markdown());
  });

  it('不正YAMLの管理対象外noteがあっても走査を継続し、noteを変更しない', async () => {
    const { root, store } = await fixture();
    const malformed = '---\ntitle: [unterminated\n---\nUser note\n';
    await put(root, 'User-note.md', malformed);

    await expect(
      reconcileCrash({ managedRoot: root, store }),
    ).resolves.toMatchObject({
      findings: [{ type: 'missing_file', notionId, path: 'Old/Page.md' }],
    });
    expect(await readFile(join(root, 'User-note.md'), 'utf8')).toBe(malformed);
  });

  it('MOVEの移動元と移動先が残っていれば移動先へDBを合わせて移動元を掃除する', async () => {
    const { root, store } = await fixture({ expectedPath: 'New/Page.md' });
    await put(root, 'Old/Page.md');
    await put(root, 'New/Page.md');
    const findings = (await reconcileCrash({ managedRoot: root, store }))
      .findings;
    expect(findings).toContainEqual({
      type: 'move_relinked',
      notionId,
      path: 'New/Page.md',
    });
    expect(findings).toContainEqual({
      type: 'duplicate_removed',
      notionId,
      path: 'Old/Page.md',
    });
    await expect(access(join(root, 'Old/Page.md'))).rejects.toThrow();
    expect(store.getResource(notionId)?.localPath).toBe('New/Page.md');
  });

  it('管理markerを持つ孤立tmpを掃除する', async () => {
    const { root, store } = await fixture();
    await put(root, '.Page.md.id.tmp');
    expect(
      (await reconcileCrash({ managedRoot: root, store })).findings,
    ).toContainEqual({
      type: 'tmp_removed',
      notionId,
      path: '.Page.md.id.tmp',
    });
    await expect(access(join(root, '.Page.md.id.tmp'))).rejects.toThrow();
  });

  it('dry-runでは検出だけを行いfileとDBを変更しない', async () => {
    const { root, store } = await fixture({ expectedPath: 'New/Page.md' });
    await put(root, 'Old/Page.md');
    await put(root, 'New/Page.md');
    await put(root, '.Page.md.id.tmp');
    const findings = (
      await reconcileCrash({ managedRoot: root, store, dryRun: true })
    ).findings;
    expect(findings.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'move_relinked',
        'duplicate_removed',
        'tmp_removed',
      ]),
    );
    expect(store.getResource(notionId)?.localPath).toBe('Old/Page.md');
    await expect(access(join(root, 'Old/Page.md'))).resolves.toBeUndefined();
    await expect(
      access(join(root, '.Page.md.id.tmp')),
    ).resolves.toBeUndefined();
  });
});
