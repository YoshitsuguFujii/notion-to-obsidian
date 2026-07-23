import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  inspectManagementMarker,
  markdownBody,
  readManagementMarker,
} from '../filesystem/management-marker.js';
import type { StateStore } from '../storage/state-store.js';
import { loadConfig } from '../config/index.js';
import { SqliteStateStore } from '../storage/sqlite-store.js';

interface VerifyOptions {
  managedRoot: string;
  store: Pick<StateStore, 'getResource' | 'listResources' | 'listAssets'>;
}

export async function runVerifyCommand(options: {
  configPath: string;
  env?: NodeJS.ProcessEnv;
}) {
  const config = await loadConfig(options.configPath, options.env);
  try {
    await access(config.state.databasePath);
  } catch {
    return runVerify({
      managedRoot: config.obsidian.managedPath,
      store: {
        getResource: () => undefined,
        listResources: () => [],
        listAssets: () => [],
      },
    });
  }
  using store = new SqliteStateStore(config.state.databasePath);
  return await runVerify({ managedRoot: config.obsidian.managedPath, store });
}

export async function runVerify(options: VerifyOptions) {
  const unmanaged: string[] = [];
  const issues: Array<{ type: string; path: string; notionId?: string }> = [];
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({ type: 'symlink', path: absolute });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = relative(resolve(options.managedRoot), absolute)
        .split(sep)
        .join('/');
      const content = await readFile(absolute, 'utf8');
      const marker = readManagementMarker(content);
      if (!marker) {
        unmanaged.push(path);
        continue;
      }
      const stored = options.store.getResource(marker.notionId);
      if (
        !inspectManagementMarker({
          managedRoot: options.managedRoot,
          filePath: absolute,
          content,
          stored,
        }).managed
      ) {
        issues.push({
          type: stored ? 'state_mismatch' : 'orphan_managed_file',
          path,
          notionId: marker.notionId,
        });
        continue;
      }
      seen.add(marker.notionId);
      const body = markdownBody(content);
      const actualHash =
        body === undefined
          ? undefined
          : createHash('sha256').update(body).digest('hex');
      if (stored?.contentHash && actualHash !== stored.contentHash) {
        issues.push({
          type: 'content_mismatch',
          path,
          notionId: marker.notionId,
        });
      }
    }
  };
  await visit(options.managedRoot);
  for (const resource of options.store.listResources()) {
    if (resource.status === 'active' && !seen.has(resource.notionId)) {
      issues.push({
        type: 'missing_file',
        path: resource.localPath ?? resource.expectedPath,
        notionId: resource.notionId,
      });
    }
  }
  for (const asset of options.store.listAssets()) {
    try {
      await access(join(options.managedRoot, asset.localPath));
    } catch {
      issues.push({
        type: 'missing_asset',
        path: asset.localPath,
        notionId: asset.pageId,
      });
    }
  }
  return {
    ok: issues.length === 0,
    ...(issues.length > 0 ? { verifyMismatch: true as const } : {}),
    unmanaged: unmanaged.sort(),
    issues,
  };
}
