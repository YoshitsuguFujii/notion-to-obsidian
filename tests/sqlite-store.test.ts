import { describe, expect, it } from 'vitest';
import { SqliteStateStore } from '../src/storage/sqlite-store.js';

describe('SqliteStateStore', () => {
  it('全状態テーブルと version 1 migration を作成する', () => {
    using store = new SqliteStateStore(':memory:');

    expect(store.schemaVersion()).toBe(1);
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
});
