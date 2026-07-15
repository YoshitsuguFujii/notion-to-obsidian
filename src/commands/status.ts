import type { StateStore } from '../storage/state-store.js';
import { access } from 'node:fs/promises';
import { loadConfig } from '../config/index.js';
import { SqliteStateStore } from '../storage/sqlite-store.js';

export function runStatus(store: StateStore) {
  const resources = store.listResources();
  const missing = resources
    .filter(({ status }) => status === 'missing')
    .map(({ notionId, localPath, missingCount }) => ({
      notionId,
      ...(localPath ? { localPath } : {}),
      missingCount,
    }));
  return {
    ok: true as const,
    latestRun: store.getLatestRun(),
    resourceCounts: {
      total: resources.length,
      active: resources.filter(({ status }) => status === 'active').length,
      missing: missing.length,
      tombstoned: resources.filter(({ status }) => status === 'tombstoned')
        .length,
    },
    warnings: store.listWarnings(store.getLatestRun()?.runId),
    missing,
  };
}

export async function runStatusCommand(options: {
  configPath: string;
  env?: NodeJS.ProcessEnv;
}) {
  const config = await loadConfig(options.configPath, options.env);
  try {
    await access(config.state.databasePath);
  } catch {
    return {
      ok: true as const,
      latestRun: undefined,
      resourceCounts: { total: 0, active: 0, missing: 0, tombstoned: 0 },
      warnings: [],
      missing: [],
    };
  }
  using store = new SqliteStateStore(config.state.databasePath);
  return runStatus(store);
}
