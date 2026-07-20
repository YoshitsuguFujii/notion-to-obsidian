import Database from 'better-sqlite3';
import type {
  NewSyncRun,
  ResourceState,
  RootState,
  StateStore,
  StoredResource,
  SyncRun,
  SyncRunCompletion,
  AssetState,
  WarningState,
} from './state-store.js';
import { migrations } from './migrations/index.js';

export class SqliteStateStore implements StateStore, Disposable {
  private readonly database: Database.Database;
  private closed = false;
  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.database = new Database(path, {
      readonly: options.readonly ?? false,
      ...(options.readonly ? { fileMustExist: true } : {}),
    });
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    if (path !== ':memory:' && !options.readonly)
      this.database.pragma('journal_mode = WAL');
    if (!options.readonly) this.migrate();
  }
  private migrate(): void {
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)',
    );
    for (const migration of migrations) {
      const applied = this.database
        .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
        .get(migration.version);
      if (applied) continue;
      this.database.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare('INSERT INTO schema_migrations(version) VALUES (?)')
          .run(migration.version);
      })();
    }
  }
  schemaVersion(): number {
    const row = this.database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    return row.version;
  }
  tableNames(): string[] {
    return (
      this.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
  }
  tableColumns(table: string): string[] {
    if (!this.tableNames().includes(table)) return [];
    return (
      this.database.pragma(`table_info(${table})`) as Array<{ name: string }>
    ).map(({ name }) => name);
  }
  pragma(name: 'foreign_keys' | 'busy_timeout'): number {
    const row = this.database.pragma(name, { simple: true });
    return Number(row);
  }
  beginRun(run: NewSyncRun): void {
    this.database
      .prepare(
        `INSERT INTO sync_runs
      (run_id, started_at, mode, partial, config_hash, api_version, tool_version, transform_version)
      VALUES (@runId, @startedAt, @mode, 0, @configHash, @apiVersion, @toolVersion, @transformVersion)`,
      )
      .run(run);
  }
  getRun(runId: string): SyncRun | undefined {
    const row = this.database
      .prepare('SELECT * FROM sync_runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id as string,
      startedAt: row.started_at as string,
      mode: row.mode as SyncRun['mode'],
      configHash: row.config_hash as string,
      apiVersion: row.api_version as string,
      toolVersion: row.tool_version as string,
      transformVersion: row.transform_version as string,
      partial: Boolean(row.partial),
      counts: {
        create: row.count_create as number,
        update: row.count_update as number,
        move: row.count_move as number,
        trash: row.count_trash as number,
        unchanged: row.count_unchanged as number,
        error: row.count_error as number,
      },
      ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}),
      ...(row.success === null ? {} : { success: Boolean(row.success) }),
    };
  }
  finishRun(completion: SyncRunCompletion): void {
    this.database
      .prepare(
        `UPDATE sync_runs SET
          finished_at = @finishedAt, success = @success, partial = @partial,
          count_create = @create, count_update = @update, count_move = @move,
          count_trash = @trash, count_unchanged = @unchanged, count_error = @error
         WHERE run_id = @runId`,
      )
      .run({
        ...completion,
        ...completion.counts,
        success: completion.success ? 1 : 0,
        partial: completion.partial ? 1 : 0,
      });
  }
  getLatestRun(): SyncRun | undefined {
    const row = this.database
      .prepare(
        'SELECT run_id FROM sync_runs ORDER BY started_at DESC, run_id DESC LIMIT 1',
      )
      .get() as { run_id: string } | undefined;
    return row ? this.getRun(row.run_id) : undefined;
  }
  upsertRoot(root: RootState): void {
    this.database
      .prepare(
        `INSERT INTO roots
          (root_page_id, local_name, last_successful_census, status, last_seen_run_id,
           last_error_category, last_error_at)
         VALUES (@rootPageId, @localName, @lastSuccessfulCensus, @status, @lastSeenRunId,
           @lastErrorCategory, @lastErrorAt)
         ON CONFLICT(root_page_id) DO UPDATE SET
           local_name = excluded.local_name,
           last_successful_census = COALESCE(excluded.last_successful_census, roots.last_successful_census),
           status = excluded.status,
           last_seen_run_id = COALESCE(excluded.last_seen_run_id, roots.last_seen_run_id),
           last_error_category = excluded.last_error_category,
           last_error_at = excluded.last_error_at`,
      )
      .run({
        ...root,
        lastSuccessfulCensus: root.lastSuccessfulCensus ?? null,
        lastSeenRunId: root.lastSeenRunId ?? null,
        lastErrorCategory: root.lastErrorCategory ?? null,
        lastErrorAt: root.lastErrorAt ?? null,
      });
  }
  getRoot(rootPageId: string): RootState | undefined {
    const row = this.database
      .prepare('SELECT * FROM roots WHERE root_page_id = ?')
      .get(rootPageId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      rootPageId: row.root_page_id as string,
      localName: row.local_name as string,
      status: row.status as RootState['status'],
      ...(row.last_successful_census
        ? { lastSuccessfulCensus: row.last_successful_census as string }
        : {}),
      ...(row.last_seen_run_id
        ? { lastSeenRunId: row.last_seen_run_id as string }
        : {}),
      ...(row.last_error_category
        ? { lastErrorCategory: row.last_error_category as string }
        : {}),
      ...(row.last_error_at
        ? { lastErrorAt: row.last_error_at as string }
        : {}),
    };
  }
  listRoots(): RootState[] {
    const rows = this.database
      .prepare('SELECT root_page_id FROM roots ORDER BY root_page_id')
      .all() as Array<{ root_page_id: string }>;
    return rows.flatMap(({ root_page_id }) => {
      const root = this.getRoot(root_page_id);
      return root ? [root] : [];
    });
  }
  upsertResource(resource: ResourceState): void {
    this.database
      .prepare(
        `INSERT INTO resources
          (notion_id, object_type, root_id, parent_id, title, local_path, expected_path,
           resolved_filename, last_edited_time, last_seen_run_id, in_trash, status,
           content_hash, structure_hash, missing_count, tombstoned_at, trash_reason,
           created_at, updated_at)
         VALUES (@notionId, @objectType, @rootId, @parentId, @title, @localPath, @expectedPath,
           @resolvedFilename, @lastEditedTime, @lastSeenRunId, @inTrash, @status,
           @contentHash, @structureHash, COALESCE(@missingCount, 0), @tombstonedAt, @trashReason,
           @createdAt, @updatedAt)
         ON CONFLICT(notion_id) DO UPDATE SET
           object_type = excluded.object_type,
           root_id = excluded.root_id,
           parent_id = excluded.parent_id,
           title = excluded.title,
           local_path = COALESCE(excluded.local_path, resources.local_path),
           expected_path = excluded.expected_path,
           resolved_filename = excluded.resolved_filename,
           last_edited_time = excluded.last_edited_time,
           last_seen_run_id = COALESCE(excluded.last_seen_run_id, resources.last_seen_run_id),
           in_trash = excluded.in_trash,
           status = excluded.status,
           content_hash = COALESCE(@contentHash, resources.content_hash),
           structure_hash = COALESCE(@structureHash, resources.structure_hash),
           missing_count = COALESCE(@missingCount, resources.missing_count),
           tombstoned_at = COALESCE(@tombstonedAt, resources.tombstoned_at),
           trash_reason = COALESCE(@trashReason, resources.trash_reason),
           updated_at = excluded.updated_at`,
      )
      .run({
        ...resource,
        parentId: resource.parentId ?? null,
        localPath: resource.localPath ?? null,
        lastSeenRunId: resource.lastSeenRunId ?? null,
        inTrash: resource.inTrash ? 1 : 0,
        contentHash: resource.contentHash ?? null,
        structureHash: resource.structureHash ?? null,
        missingCount: resource.missingCount ?? null,
        tombstonedAt: resource.tombstonedAt ?? null,
        trashReason: resource.trashReason ?? null,
      });
  }
  updateResourceMissingState(
    notionId: string,
    state: { missingCount: number; status?: ResourceState['status'] },
  ): void {
    this.database
      .prepare(
        `UPDATE resources
         SET missing_count = @missingCount,
             status = COALESCE(@status, status)
         WHERE notion_id = @notionId`,
      )
      .run({
        notionId,
        missingCount: state.missingCount,
        status: state.status ?? null,
      });
  }
  getResource(notionId: string): StoredResource | undefined {
    const row = this.database
      .prepare('SELECT * FROM resources WHERE notion_id = ?')
      .get(notionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      notionId: row.notion_id as string,
      objectType: row.object_type as StoredResource['objectType'],
      rootId: row.root_id as string,
      ...(row.parent_id ? { parentId: row.parent_id as string } : {}),
      title: row.title as string,
      ...(row.local_path ? { localPath: row.local_path as string } : {}),
      expectedPath: row.expected_path as string,
      resolvedFilename: row.resolved_filename as string,
      lastEditedTime: row.last_edited_time as string,
      ...(row.last_seen_run_id
        ? { lastSeenRunId: row.last_seen_run_id as string }
        : {}),
      inTrash: Boolean(row.in_trash),
      status: row.status as StoredResource['status'],
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      ...(row.content_hash ? { contentHash: row.content_hash as string } : {}),
      ...(row.structure_hash
        ? { structureHash: row.structure_hash as string }
        : {}),
      missingCount: row.missing_count as number,
      ...(row.tombstoned_at
        ? { tombstonedAt: row.tombstoned_at as string }
        : {}),
      ...(row.trash_reason ? { trashReason: row.trash_reason as string } : {}),
    };
  }
  listResources(): StoredResource[] {
    const rows = this.database
      .prepare('SELECT notion_id FROM resources ORDER BY notion_id')
      .all() as Array<{ notion_id: string }>;
    return rows.flatMap(({ notion_id }) => {
      const resource = this.getResource(notion_id);
      return resource ? [resource] : [];
    });
  }
  listUnfinishedRuns(): SyncRun[] {
    const rows = this.database
      .prepare(
        'SELECT run_id FROM sync_runs WHERE finished_at IS NULL ORDER BY started_at, run_id',
      )
      .all() as Array<{ run_id: string }>;
    return rows.flatMap(({ run_id }) => {
      const run = this.getRun(run_id);
      return run ? [run] : [];
    });
  }
  upsertAsset(asset: AssetState): void {
    this.database
      .prepare(
        `INSERT INTO assets
          (stable_key, page_id, block_id, local_path, original_name, mime_type, size,
           content_hash, etag, last_modified, last_seen_run_id, fetched_at)
         VALUES (@stableKey, @pageId, @blockId, @localPath, @originalName, @mimeType, @size,
           @contentHash, @etag, @lastModified, @lastSeenRunId, @fetchedAt)
         ON CONFLICT(stable_key) DO UPDATE SET
           local_path = excluded.local_path, original_name = excluded.original_name,
           mime_type = excluded.mime_type, size = excluded.size,
           content_hash = excluded.content_hash, etag = excluded.etag,
           last_modified = excluded.last_modified,
           last_seen_run_id = excluded.last_seen_run_id, fetched_at = excluded.fetched_at`,
      )
      .run({
        ...asset,
        mimeType: asset.mimeType ?? null,
        size: asset.size ?? null,
        contentHash: asset.contentHash ?? null,
        etag: asset.etag ?? null,
        lastModified: asset.lastModified ?? null,
        lastSeenRunId: asset.lastSeenRunId ?? null,
        fetchedAt: asset.fetchedAt ?? null,
      });
  }
  getAsset(stableKey: string): AssetState | undefined {
    const row = this.database
      .prepare('SELECT * FROM assets WHERE stable_key = ?')
      .get(stableKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      stableKey: row.stable_key as string,
      pageId: row.page_id as string,
      blockId: row.block_id as string,
      localPath: row.local_path as string,
      originalName: row.original_name as string,
      ...(row.mime_type ? { mimeType: row.mime_type as string } : {}),
      ...(row.size === null ? {} : { size: row.size as number }),
      ...(row.content_hash ? { contentHash: row.content_hash as string } : {}),
      ...(row.etag ? { etag: row.etag as string } : {}),
      ...(row.last_modified
        ? { lastModified: row.last_modified as string }
        : {}),
      ...(row.last_seen_run_id
        ? { lastSeenRunId: row.last_seen_run_id as string }
        : {}),
      ...(row.fetched_at ? { fetchedAt: row.fetched_at as string } : {}),
    };
  }
  listAssets(): AssetState[] {
    const rows = this.database
      .prepare('SELECT stable_key FROM assets ORDER BY stable_key')
      .all() as Array<{ stable_key: string }>;
    return rows.flatMap(({ stable_key }) => {
      const asset = this.getAsset(stable_key);
      return asset ? [asset] : [];
    });
  }
  insertWarning(warning: WarningState): void {
    this.database
      .prepare(
        `INSERT INTO warnings
          (run_id, resource_id, warning_type, message, created_at)
         VALUES (@runId, @resourceId, @warningType, @message, @createdAt)`,
      )
      .run({ ...warning, resourceId: warning.resourceId ?? null });
  }
  listWarnings(runId?: string): WarningState[] {
    const rows = (
      runId
        ? this.database
            .prepare(
              'SELECT * FROM warnings WHERE run_id = ? ORDER BY created_at, rowid',
            )
            .all(runId)
        : this.database
            .prepare('SELECT * FROM warnings ORDER BY created_at, rowid')
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: row.run_id as string,
      ...(row.resource_id ? { resourceId: row.resource_id as string } : {}),
      warningType: row.warning_type as string,
      message: row.message as string,
      createdAt: row.created_at as string,
    }));
  }
  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }
  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
  [Symbol.dispose](): void {
    this.close();
  }
}
