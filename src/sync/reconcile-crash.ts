import { readFile, readdir, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  inspectManagementMarker,
  readManagementMarker,
} from '../filesystem/management-marker.js';
import type { StateStore, StoredResource } from '../storage/state-store.js';

export type CrashFinding =
  | { type: 'unfinished_run'; runId: string }
  | { type: 'content_relinked'; notionId: string; path: string }
  | { type: 'move_relinked'; notionId: string; path: string }
  | { type: 'trash_relinked'; notionId: string; path: string }
  | { type: 'missing_file'; notionId: string; path: string }
  | { type: 'orphan_managed_file'; notionId: string; path: string }
  | { type: 'duplicate_removed'; notionId: string; path: string }
  | { type: 'tmp_removed'; notionId: string; path: string };

interface ReconcileCrashOptions {
  managedRoot: string;
  store: StateStore;
  dryRun?: boolean;
  now?: string;
}

interface ScannedFile {
  absolutePath: string;
  path: string;
  content: string;
  notionId: string;
  contentHash?: string;
  temporary: boolean;
}

async function scanManagedMarkers(managedRoot: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith('.md') && !entry.name.endsWith('.tmp'))
      )
        continue;
      const content = await readFile(absolutePath, 'utf8');
      const marker = readManagementMarker(content);
      if (!marker) continue;
      files.push({
        absolutePath,
        path: relative(resolve(managedRoot), absolutePath).split(sep).join('/'),
        content,
        notionId: marker.notionId,
        ...(marker.contentHash ? { contentHash: marker.contentHash } : {}),
        temporary: entry.name.endsWith('.tmp'),
      });
    }
  };
  await visit(resolve(managedRoot));
  return files;
}

function saveResource(
  store: StateStore,
  resource: StoredResource,
  changes: Partial<StoredResource>,
  now: string,
  dryRun: boolean,
): void {
  if (dryRun) return;
  store.upsertResource({ ...resource, ...changes, updatedAt: now });
}

export async function reconcileCrash(
  options: ReconcileCrashOptions,
): Promise<{ findings: CrashFinding[] }> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date().toISOString();
  const findings: CrashFinding[] = options.store
    .listUnfinishedRuns()
    .map(({ runId }) => ({ type: 'unfinished_run' as const, runId }));
  const resources = options.store.listResources();
  const byId = new Map(
    resources.map((resource) => [resource.notionId, resource]),
  );
  const files = await scanManagedMarkers(options.managedRoot);

  for (const file of files.filter(({ temporary }) => temporary)) {
    if (!byId.has(file.notionId)) continue;
    findings.push({
      type: 'tmp_removed',
      notionId: file.notionId,
      path: file.path,
    });
    if (!dryRun) await unlink(file.absolutePath);
  }

  const stableFiles = files.filter(({ temporary }) => !temporary);
  for (const resource of resources) {
    const matching = stableFiles.filter(
      ({ notionId }) => notionId === resource.notionId,
    );
    const expected = matching.find(
      ({ path }) => path === resource.expectedPath,
    );
    const local = resource.localPath
      ? matching.find(({ path }) => path === resource.localPath)
      : undefined;
    const trashed = matching.find(({ path }) => path.startsWith('.trash/'));

    if (trashed && !expected && !local) {
      findings.push({
        type: 'trash_relinked',
        notionId: resource.notionId,
        path: trashed.path,
      });
      saveResource(
        options.store,
        resource,
        {
          localPath: trashed.path,
          status: 'tombstoned',
          inTrash: true,
          tombstonedAt: now,
          trashReason: 'manual_reconcile',
          ...(trashed.contentHash ? { contentHash: trashed.contentHash } : {}),
        },
        now,
        dryRun,
      );
      continue;
    }

    if (expected && resource.localPath !== resource.expectedPath) {
      findings.push({
        type: 'move_relinked',
        notionId: resource.notionId,
        path: expected.path,
      });
      saveResource(
        options.store,
        resource,
        {
          localPath: expected.path,
          ...(expected.contentHash
            ? { contentHash: expected.contentHash }
            : {}),
        },
        now,
        dryRun,
      );
      if (
        local &&
        local.path !== expected.path &&
        inspectManagementMarker({
          managedRoot: options.managedRoot,
          filePath: local.absolutePath,
          content: local.content,
          stored: resource,
        }).managed
      ) {
        findings.push({
          type: 'duplicate_removed',
          notionId: resource.notionId,
          path: local.path,
        });
        if (!dryRun) await unlink(local.absolutePath);
      }
      continue;
    }

    if (local) {
      if (local.contentHash && local.contentHash !== resource.contentHash) {
        findings.push({
          type: 'content_relinked',
          notionId: resource.notionId,
          path: local.path,
        });
        saveResource(
          options.store,
          resource,
          { contentHash: local.contentHash },
          now,
          dryRun,
        );
      }
      continue;
    }

    findings.push({
      type: 'missing_file',
      notionId: resource.notionId,
      path: resource.localPath ?? resource.expectedPath,
    });
  }

  for (const file of stableFiles) {
    if (byId.has(file.notionId)) continue;
    findings.push({
      type: 'orphan_managed_file',
      notionId: file.notionId,
      path: file.path,
    });
  }
  return { findings };
}
