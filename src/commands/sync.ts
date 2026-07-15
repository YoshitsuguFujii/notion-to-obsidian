import { access, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { loadConfig } from '../config/index.js';
import { censusRoot } from '../notion/census.js';
import { NotionSdkClient } from '../notion/client.js';
import { retrieveMarkdownWithFallback } from '../notion/markdown.js';
import { fetchDataSourceRows } from '../notion/data-sources.js';
import { retrieveBlockTree } from '../notion/blocks.js';
import { NodeHttpDownloader } from '../assets/http-downloader.js';
import { createLogger } from '../logging/index.js';
import { FileLock } from '../storage/lock.js';
import { SqliteStateStore } from '../storage/sqlite-store.js';
import { reconcileCrash } from '../sync/reconcile-crash.js';
import { runSyncOrchestrator, type SyncOptions } from '../sync/orchestrator.js';

export interface SyncCommandOptions extends SyncOptions {
  configPath: string;
  env?: NodeJS.ProcessEnv;
}

export async function runSyncCommand(options: SyncCommandOptions) {
  const config = await loadConfig(options.configPath, options.env);
  const dryRun = options.dryRun ?? false;
  if (!dryRun)
    await mkdir(dirname(config.state.databasePath), { recursive: true });
  let statePath = config.state.databasePath;
  let readOnly = false;
  if (dryRun) {
    try {
      await access(statePath);
      readOnly = true;
    } catch {
      statePath = ':memory:';
    }
  }
  using store = new SqliteStateStore(statePath, { readonly: readOnly });
  const client = new NotionSdkClient({
    token: config.notion.token,
    requestRatePerSecond: config.notion.requestRatePerSecond,
    concurrency: config.notion.concurrency,
  });
  const lock = new FileLock(`${config.state.databasePath}.lock`, { dryRun });
  const downloader = new NodeHttpDownloader();
  const logger = createLogger({
    format: config.logging.format,
    level: options.verbose ? 'debug' : config.logging.level,
    token: config.notion.token,
  });
  const result = await runSyncOrchestrator(config, options, {
    store,
    lock,
    census: (rootId) => censusRoot(client, rootId),
    retrieveContent: (pageId) => retrieveMarkdownWithFallback(client, pageId),
    fetchDataSourceRows: (dataSourceId) =>
      fetchDataSourceRows(client, dataSourceId),
    retrieveBlocks: (pageId) => retrieveBlockTree(client, pageId),
    downloadAsset: (request) => downloader.download(request),
    logger,
    now: () => new Date().toISOString(),
    runId: randomUUID,
    recover: (recoveryDryRun) =>
      reconcileCrash({
        managedRoot: config.obsidian.managedPath,
        store,
        dryRun: recoveryDryRun,
      }).then(() => undefined),
  });
  return {
    ok: !result.partialFailure && !result.partial,
    ...(result.partialFailure || result.partial
      ? { partial: true as const }
      : {}),
    ...result,
  };
}
