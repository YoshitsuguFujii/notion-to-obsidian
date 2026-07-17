import {
  lstat,
  readFile,
  readdir,
  unlink as nodeUnlink,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { InfraError } from '../errors.js';
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
  unlink?: (path: string) => Promise<void>;
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
      const temporary = entry.name.endsWith('.tmp');
      files.push({
        absolutePath,
        path: relative(resolve(managedRoot), absolutePath).split(sep).join('/'),
        content,
        notionId: marker.notionId,
        ...(marker.contentHash ? { contentHash: marker.contentHash } : {}),
        temporary,
      });
    }
  };
  await visit(resolve(managedRoot));
  return files;
}

async function findLinkedTrash(
  source: ScannedFile,
  trashCandidates: ScannedFile[],
): Promise<ScannedFile | undefined> {
  const sourceIdentity = await lstat(source.absolutePath, { bigint: true });
  for (const candidate of trashCandidates) {
    if (candidate.path === source.path) continue;
    const candidateIdentity = await lstat(candidate.absolutePath, {
      bigint: true,
    });
    if (
      sourceIdentity.dev === candidateIdentity.dev &&
      sourceIdentity.ino === candidateIdentity.ino
    ) {
      return candidate;
    }
  }
  return undefined;
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
  const unlinkFile = options.unlink ?? nodeUnlink;
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
    if (!dryRun) await unlinkFile(file.absolutePath);
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
    const trashCandidates = matching.filter(({ path }) =>
      path.startsWith('.trash/'),
    );
    const trashed = trashCandidates[0];

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

    const sourceIsAtExpectedPath =
      local !== undefined && resource.localPath === resource.expectedPath;
    const sourceIsManaged = local
      ? inspectManagementMarker({
          managedRoot: options.managedRoot,
          filePath: local.absolutePath,
          content: local.content,
          stored: resource,
        }).managed
      : false;
    const linkedTrash =
      local &&
      sourceIsAtExpectedPath &&
      sourceIsManaged &&
      trashCandidates.length > 0
        ? await findLinkedTrash(local, trashCandidates)
        : undefined;

    if (local && linkedTrash) {
      findings.push({
        type: 'trash_relinked',
        notionId: resource.notionId,
        path: linkedTrash.path,
      });
      findings.push({
        type: 'duplicate_removed',
        notionId: resource.notionId,
        path: local.path,
      });
      if (!dryRun) {
        try {
          await unlinkFile(local.absolutePath);
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : 'unknown error';
          throw new InfraError('storage', `Trash recovery failed: ${message}`, {
            cause,
          });
        }
      }
      saveResource(
        options.store,
        resource,
        {
          localPath: linkedTrash.path,
          status: 'tombstoned',
          inTrash: true,
          tombstonedAt: now,
          trashReason: 'manual_reconcile',
          ...(linkedTrash.contentHash
            ? { contentHash: linkedTrash.contentHash }
            : {}),
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
        if (!dryRun) await unlinkFile(local.absolutePath);
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
