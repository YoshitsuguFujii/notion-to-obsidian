import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql as initialSchema } from '../src/storage/migrations/001-initial.js';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

async function versionOneDatabase(): Promise<{
  directory: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'notion-state-v1-'));
  const path = join(directory, 'state.db');
  const database = new Database(path);
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)');
  database.exec(initialSchema);
  database.prepare('INSERT INTO schema_migrations(version) VALUES (1)').run();
  database
    .prepare(
      `INSERT INTO sync_runs
       (run_id, started_at, mode, partial, config_hash, api_version, tool_version, transform_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'run',
      '2026-07-20T00:00:00.000Z',
      'incremental',
      0,
      'config',
      '2026-03-11',
      '0.1.0',
      '1',
    );
  database
    .prepare(
      `INSERT INTO roots
       (root_page_id, local_name, status, last_seen_run_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run('page', 'Notes', 'complete', 'run');
  database
    .prepare(
      `INSERT INTO resources
       (notion_id, object_type, root_id, title, expected_path, resolved_filename,
        last_edited_time, last_seen_run_id, in_trash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'page',
      'page',
      'page',
      'Page',
      'Notes.md',
      'Notes',
      '2026-07-20T00:00:00.000Z',
      'run',
      0,
      'active',
      '2026-07-20T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    );
  database
    .prepare(
      `INSERT INTO assets
       (stable_key, page_id, block_id, local_path, original_name)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      'page:block',
      'page',
      'block',
      '_assets/page/block--photo.png',
      'photo.png',
    );
  database.close();
  return { directory, path };
}

describe('SqliteStateStore', () => {
  it('全状態テーブルと最新migrationを作成する', () => {
    using store = new SqliteStateStore(':memory:');

    expect(store.schemaVersion()).toBe(2);
    expect(store.tableNames()).toEqual(
      expect.arrayContaining([
        'schema_migrations',
        'sync_runs',
        'roots',
        'resources',
        'assets',
        'warnings',
      ]),
    );
    expect(store.tableColumns('sync_runs')).toEqual([
      'run_id',
      'started_at',
      'finished_at',
      'mode',
      'success',
      'partial',
      'config_hash',
      'api_version',
      'tool_version',
      'transform_version',
      'count_create',
      'count_update',
      'count_move',
      'count_trash',
      'count_unchanged',
      'count_error',
    ]);
    expect(store.tableColumns('roots')).toEqual([
      'root_page_id',
      'local_name',
      'last_successful_census',
      'status',
      'last_seen_run_id',
      'last_error_category',
      'last_error_at',
    ]);
    expect(store.tableColumns('resources')).toEqual([
      'notion_id',
      'object_type',
      'root_id',
      'parent_id',
      'title',
      'local_path',
      'expected_path',
      'resolved_filename',
      'last_edited_time',
      'content_hash',
      'structure_hash',
      'last_seen_run_id',
      'in_trash',
      'status',
      'missing_count',
      'tombstoned_at',
      'trash_reason',
      'created_at',
      'updated_at',
    ]);
    expect(store.tableColumns('assets')).toEqual([
      'stable_key',
      'page_id',
      'block_id',
      'local_path',
      'original_name',
      'mime_type',
      'size',
      'content_hash',
      'etag',
      'last_modified',
      'last_seen_run_id',
      'fetched_at',
      'cache_status',
    ]);
    expect(store.tableColumns('warnings')).toEqual([
      'run_id',
      'resource_id',
      'warning_type',
      'message',
      'created_at',
    ]);
    expect(store.tableColumns('schema_migrations')).toEqual(['version']);
  });

  it('外部キーと busy timeout を有効にする', () => {
    using store = new SqliteStateStore(':memory:');

    expect(store.pragma('foreign_keys')).toBe(1);
    expect(store.pragma('busy_timeout')).toBe(5000);
  });

  it('transaction が失敗した場合に変更を残さない', () => {
    using store = new SqliteStateStore(':memory:');

    expect(() =>
      store.transaction(() => {
        store.beginRun({
          runId: 'run-1',
          startedAt: '2026-07-11T00:00:00.000Z',
          mode: 'full',
          configHash: 'config',
          apiVersion: '2026-03-11',
          toolVersion: '0.1.0',
          transformVersion: '1',
        });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(store.getRun('run-1')).toBeUndefined();
  });

  it('version 1の既存assetをusableとして移行する', async () => {
    const fixture = await versionOneDatabase();
    try {
      using store = new SqliteStateStore(fixture.path);

      expect(store.schemaVersion()).toBe(2);
      expect(store.getAsset('page:block')).toMatchObject({
        cacheStatus: 'usable',
      });
      expect(store.pragma('foreign_keys')).toBe(1);
      expect(store.pragma('busy_timeout')).toBe(5000);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('適用済みmigrationは再実行しても状態を変えない', async () => {
    const fixture = await versionOneDatabase();
    try {
      new SqliteStateStore(fixture.path).close();
      using reopened = new SqliteStateStore(fixture.path);

      expect(reopened.schemaVersion()).toBe(2);
      expect(reopened.getAsset('page:block')).toMatchObject({
        cacheStatus: 'usable',
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('未定義のcache状態は保存しない', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-state-v2-'));
    const path = join(directory, 'state.db');
    try {
      new SqliteStateStore(path).close();
      const database = new Database(path);
      try {
        expect(() =>
          database
            .prepare(
              `INSERT INTO assets
               (stable_key, page_id, block_id, local_path, original_name, cache_status)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              'page:block',
              'page',
              'block',
              '_assets/page/block--photo.png',
              'photo.png',
              'unknown',
            ),
        ).toThrow();
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
