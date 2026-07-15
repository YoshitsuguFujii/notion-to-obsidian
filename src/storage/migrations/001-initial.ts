export const version = 1;
export const sql = `
CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental', 'page', 'root')),
  success INTEGER CHECK (success IN (0, 1) OR success IS NULL),
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
  config_hash TEXT NOT NULL,
  api_version TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  count_create INTEGER NOT NULL DEFAULT 0,
  count_update INTEGER NOT NULL DEFAULT 0,
  count_move INTEGER NOT NULL DEFAULT 0,
  count_trash INTEGER NOT NULL DEFAULT 0,
  count_unchanged INTEGER NOT NULL DEFAULT 0,
  count_error INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE roots (
  root_page_id TEXT PRIMARY KEY,
  local_name TEXT NOT NULL,
  last_successful_census TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  last_seen_run_id TEXT,
  last_error_category TEXT,
  last_error_at TEXT,
  FOREIGN KEY(last_seen_run_id) REFERENCES sync_runs(run_id)
);
CREATE TABLE resources (
  notion_id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  local_path TEXT,
  expected_path TEXT NOT NULL,
  resolved_filename TEXT NOT NULL,
  last_edited_time TEXT NOT NULL,
  content_hash TEXT,
  structure_hash TEXT,
  last_seen_run_id TEXT,
  in_trash INTEGER NOT NULL DEFAULT 0 CHECK (in_trash IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'tombstoned', 'missing')),
  missing_count INTEGER NOT NULL DEFAULT 0,
  tombstoned_at TEXT,
  trash_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(root_id) REFERENCES roots(root_page_id),
  FOREIGN KEY(last_seen_run_id) REFERENCES sync_runs(run_id)
);
CREATE TABLE assets (
  stable_key TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  content_hash TEXT,
  etag TEXT,
  last_modified TEXT,
  last_seen_run_id TEXT,
  fetched_at TEXT,
  FOREIGN KEY(page_id) REFERENCES resources(notion_id),
  FOREIGN KEY(last_seen_run_id) REFERENCES sync_runs(run_id)
);
CREATE TABLE warnings (
  run_id TEXT NOT NULL,
  resource_id TEXT,
  warning_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES sync_runs(run_id),
  FOREIGN KEY(resource_id) REFERENCES resources(notion_id)
);
`;
