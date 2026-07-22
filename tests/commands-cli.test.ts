import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/index.js';
import { exitCodeFor } from '../src/commands/result.js';
import { runStatus } from '../src/commands/status.js';
import { runVerify } from '../src/commands/verify.js';
import { DomainError, InfraError } from '../src/errors.js';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

describe('exitCodeFor', () => {
  it.each([
    [{ ok: true }, 0],
    [{ ok: false, partial: true }, 2],
    [{ ok: false, safetyStopped: true }, 3],
    [{ ok: false, verifyMismatch: true }, 4],
    [{ ok: false, lockFailed: true }, 5],
    [{ ok: false }, 1],
  ] as const)('resultを終了コードへ分類する', (result, expected) => {
    expect(exitCodeFor(result)).toBe(expected);
  });

  it('error categoryを安全・lock・一般へ分類する', () => {
    expect(exitCodeFor(undefined, new DomainError('safety', 'unsafe'))).toBe(3);
    expect(
      exitCodeFor(undefined, new DomainError('safety', 'sync lock is held')),
    ).toBe(5);
    expect(
      exitCodeFor(undefined, new InfraError('authentication', 'denied')),
    ).toBe(1);
  });
});

describe('status and verify', () => {
  it('前回runとresource集計、missing一覧を返す', () => {
    using store = new SqliteStateStore(':memory:');
    store.beginRun({
      runId: 'run-1',
      startedAt: '2026-07-12T00:00:00.000Z',
      mode: 'full',
      configHash: 'config',
      apiVersion: '2026-03-11',
      toolVersion: '0.1.0',
      transformVersion: '1',
    });
    store.finishRun({
      runId: 'run-1',
      finishedAt: '2026-07-12T01:00:00.000Z',
      success: true,
      partial: false,
      counts: {
        create: 1,
        update: 0,
        move: 0,
        trash: 0,
        unchanged: 0,
        error: 0,
      },
    });
    store.upsertRoot({
      rootPageId: 'root',
      localName: 'Root',
      status: 'complete',
    });
    store.upsertResource({
      notionId: 'page',
      objectType: 'page',
      rootId: 'root',
      title: 'Page',
      localPath: 'Page.md',
      expectedPath: 'Page.md',
      resolvedFilename: 'Page',
      lastEditedTime: '2026-07-12T00:00:00.000Z',
      inTrash: false,
      status: 'missing',
      missingCount: 1,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T01:00:00.000Z',
    });
    store.insertWarning({
      runId: 'run-1',
      resourceId: 'page',
      warningType: 'test_warning',
      message: 'warning',
      createdAt: '2026-07-12T01:00:00.000Z',
    });
    expect(runStatus(store)).toMatchObject({
      ok: true,
      latestRun: { runId: 'run-1' },
      resourceCounts: { total: 1, missing: 1 },
      warnings: [expect.objectContaining({ warningType: 'test_warning' })],
      missing: [{ notionId: 'page' }],
    });
  });

  it('管理対象外fileをerrorにせずunmanagedとして報告する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-verify-'));
    await mkdir(join(root, 'Mirror'));
    await writeFile(
      join(root, 'Mirror', 'User.md'),
      '---\ntitle: User\n---\nBody',
    );
    using store = new SqliteStateStore(':memory:');
    const result = await runVerify({
      managedRoot: join(root, 'Mirror'),
      store,
    });
    expect(result).toMatchObject({
      ok: true,
      unmanaged: ['User.md'],
      issues: [],
    });
  });

  it('DB assetのlocal fileが無ければverify不整合にする', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-verify-'));
    await mkdir(join(root, 'Mirror'));
    using store = new SqliteStateStore(':memory:');
    store.upsertRoot({
      rootPageId: 'root',
      localName: 'Root',
      status: 'complete',
    });
    store.upsertResource({
      notionId: 'page',
      objectType: 'page',
      rootId: 'root',
      title: 'Page',
      expectedPath: 'Page.md',
      resolvedFilename: 'Page',
      lastEditedTime: '',
      inTrash: false,
      status: 'tombstoned',
      createdAt: '',
      updatedAt: '',
    });
    store.upsertAsset({
      stableKey: 'page:block',
      pageId: 'page',
      blockId: 'block',
      localPath: '_assets/page/missing.png',
      originalName: 'missing.png',
    });
    await expect(
      runVerify({ managedRoot: join(root, 'Mirror'), store }),
    ).resolves.toMatchObject({
      ok: false,
      verifyMismatch: true,
      issues: [expect.objectContaining({ type: 'missing_asset' })],
    });
  });

  it('管理対象Markdownの本文が保存時から変わっていればverify不整合にする', async () => {
    const app = await import('./e2e/sync-harness.js');
    const harness = await app.createSyncHarness([app.rootPage()]);
    try {
      await harness.sync();
      const path = join(harness.managedRoot, 'Notes.md');
      const content = await readFile(path, 'utf8');
      await writeFile(path, content.replace('# Root', '# Local edit'));

      await expect(
        runVerify({ managedRoot: harness.managedRoot, store: harness.store }),
      ).resolves.toMatchObject({
        ok: false,
        verifyMismatch: true,
        issues: [
          expect.objectContaining({
            type: 'content_mismatch',
            notionId: app.ROOT_ID,
          }),
        ],
      });
    } finally {
      await harness.close();
    }
  });
});

describe('CLI', () => {
  it.each(['doctor', 'plan', 'sync', 'status', 'verify'])(
    '%s commandを登録する',
    (name) => {
      const program = createProgram({ write: vi.fn() });
      expect(program.commands.map((command) => command.name())).toContain(name);
    },
  );

  it('sync optionsをhandlerへ渡しJSONを出力する', async () => {
    const write = vi.fn();
    const sync = vi.fn(() =>
      Promise.resolve({
        ok: true,
        actions: [
          {
            type: 'ASSET_DEFERRED',
            stableKey: 'page:block',
            path: '_assets/page/block--photo.png',
          },
        ],
      }),
    );
    const program = createProgram({ write, handlers: { sync } });
    await program.parseAsync([
      'node',
      'cli',
      'sync',
      '--config',
      'x.yaml',
      '--dry-run',
      '--full',
      '--page-id',
      'page',
      '--root',
      'root',
      '--verbose',
      '--strict',
      '--allow-large-trash',
      '--json',
    ]);
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: 'x.yaml',
        dryRun: true,
        full: true,
        pageId: 'page',
        rootId: 'root',
        verbose: true,
        strict: true,
        allowLargeTrash: true,
      }),
    );
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      ok: true,
      actions: [
        {
          type: 'ASSET_DEFERRED',
          stableKey: 'page:block',
          path: '_assets/page/block--photo.png',
        },
      ],
    });
  });

  it('dry-runで判断を延期したアセットを通常出力に示す', async () => {
    const write = vi.fn();
    const program = createProgram({
      write,
      handlers: {
        sync: () => ({
          ok: true,
          actions: [
            {
              type: 'ASSET_DEFERRED',
              stableKey: 'page:block',
              path: '_assets/page/block--photo.png',
            },
          ],
        }),
      },
    });

    await program.parseAsync(['node', 'cli', 'sync', '--dry-run']);

    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'ASSET_DEFERRED',
        stableKey: 'page:block',
        path: '_assets/page/block--photo.png',
      })}\n`,
    );
  });

  it.each([
    ['通常出力', []],
    ['JSON出力', ['--json']],
  ] as const)('%sでWARNING messageを出力する', async (_format, options) => {
    const write = vi.fn();
    const warningMessage =
      'Replaced 2 retained Notion signed asset URL occurrence(s) with stable references.';
    const program = createProgram({
      write,
      handlers: {
        sync: () => ({
          ok: false,
          partial: true,
          actions: [
            {
              type: 'WARNING' as const,
              notionId: 'page',
              message: warningMessage,
            },
          ],
        }),
      },
    });

    await program.parseAsync(['node', 'cli', 'sync', ...options]);

    const calls: unknown[][] = write.mock.calls;
    const output = calls
      .flatMap((call) => call)
      .map(String)
      .join('');
    expect(output).toContain(warningMessage);
  });
});
