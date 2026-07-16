import {
  access,
  copyFile as nodeCopyFile,
  link as nodeLink,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink as nodeUnlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DomainError, InfraError } from '../errors.js';
import { assertNoSymlinkEscape, joinManagedPath } from './safe-path.js';
import {
  inspectManagementMarker,
  type StoredManagementRecord,
} from './management-marker.js';

interface MoveOptions {
  managedRoot: string;
  sourcePath: string;
  targetPath: string;
  stored: StoredManagementRecord;
  link?: (existingPath: string, newPath: string) => Promise<void>;
  copyFile?: (from: string, to: string, mode?: number) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  onMoved?: (targetPath: string) => void | Promise<void>;
}

export interface MoveResult {
  moved: boolean;
  targetPath: string;
}

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

const copyFallbackCodes = new Set([
  'EXDEV',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EMLINK',
]);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function targetExistsError(cause: unknown): DomainError {
  return new DomainError(
    'safety',
    'Move target already exists; run plan again before syncing',
    { cause },
  );
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

async function removeEmptyParent(
  managedRoot: string,
  sourceAbsolutePath: string,
): Promise<void> {
  const parent = dirname(sourceAbsolutePath);
  if (resolve(parent) === resolve(managedRoot)) return;
  if ((await readdir(parent)).length === 0) await rmdir(parent);
}

export async function moveManagedFile(
  options: MoveOptions,
): Promise<MoveResult> {
  const source = joinManagedPath(options.managedRoot, options.sourcePath);
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

  const targetPath = options.targetPath.split('\\').join('/');
  const target = joinManagedPath(options.managedRoot, targetPath);
  await assertNoSymlinkEscape(inspector, options.managedRoot, target);
  if (await exists(target)) {
    throw new DomainError(
      'safety',
      'Move target already exists; run plan again before syncing',
    );
  }
  await mkdir(dirname(target), { recursive: true });

  try {
    try {
      await (options.link ?? nodeLink)(source, target);
    } catch (linkCause) {
      if (errorCode(linkCause) === 'EEXIST') throw targetExistsError(linkCause);
      if (!copyFallbackCodes.has(errorCode(linkCause) ?? '')) throw linkCause;
      try {
        await (options.copyFile ?? nodeCopyFile)(
          source,
          target,
          constants.COPYFILE_EXCL,
        );
      } catch (copyCause) {
        if (errorCode(copyCause) === 'EEXIST')
          throw targetExistsError(copyCause);
        await rm(target, { force: true });
        throw copyCause;
      }
    }
    await (options.unlink ?? nodeUnlink)(source);
    await options.onMoved?.(targetPath);
    await removeEmptyParent(options.managedRoot, source);
    return { moved: true, targetPath };
  } catch (cause) {
    if (cause instanceof DomainError) throw cause;
    const message = cause instanceof Error ? cause.message : 'unknown error';
    throw new InfraError('storage', `Managed move failed: ${message}`, {
      cause,
    });
  }
}
