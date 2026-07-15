import { access, lstat, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { DomainError, InfraError } from '../errors.js';
import type { TrashReason } from '../sync/deletion-guard.js';
import {
  inspectManagementMarker,
  type StoredManagementRecord,
} from './management-marker.js';
import { assertNoSymlinkEscape, joinManagedPath } from './safe-path.js';

interface TrashOptions {
  managedRoot: string;
  sourcePath: string;
  notionId: string;
  stored: StoredManagementRecord;
  reason: TrashReason;
  date: string;
  dryRun?: boolean;
  onTrashed?: (result: {
    trashPath: string;
    reason: TrashReason;
  }) => void | Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function withId(path: string, notionId: string): string {
  const extension = posix.extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem}--${notionId.replaceAll('-', '').slice(0, 8)}${extension}`;
}

export async function trashManagedFile(
  options: TrashOptions,
): Promise<{ trashed: boolean; trashPath: string }> {
  const source = joinManagedPath(options.managedRoot, options.sourcePath);
  const inspector = {
    async isSymbolicLink(path: string): Promise<boolean> {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  };
  await assertNoSymlinkEscape(inspector, options.managedRoot, source);
  const content = await readFile(source, 'utf8');
  if (
    !inspectManagementMarker({
      managedRoot: options.managedRoot,
      filePath: source,
      content,
      stored: options.stored,
    }).managed
  ) {
    throw new DomainError('safety', 'Source file is not managed');
  }

  let trashPath = posix.join('.trash', options.date, options.sourcePath);
  let target = joinManagedPath(options.managedRoot, trashPath);
  await assertNoSymlinkEscape(inspector, options.managedRoot, target);
  if (!options.dryRun) await mkdir(dirname(target), { recursive: true });
  if (await exists(target)) {
    trashPath = withId(trashPath, options.notionId);
    target = joinManagedPath(options.managedRoot, trashPath);
    await assertNoSymlinkEscape(inspector, options.managedRoot, target);
    if (await exists(target)) {
      throw new DomainError('safety', 'Trash collision path already exists');
    }
  }
  if (options.dryRun) return { trashed: false, trashPath };

  try {
    await rename(source, target);
    await options.onTrashed?.({ trashPath, reason: options.reason });
    return { trashed: true, trashPath };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error';
    throw new InfraError('storage', `Trash move failed: ${message}`, { cause });
  }
}
