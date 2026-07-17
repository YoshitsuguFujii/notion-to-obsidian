import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DomainError, InfraError } from '../errors.js';
import {
  inspectManagementMarker,
  type StoredManagementRecord,
} from './management-marker.js';
import { claimTargetExclusively } from './exclusive-target-claim.js';
import { assertNoSymlinkEscape } from './safe-path.js';

interface BaseAtomicWriteOptions {
  dryRun?: boolean;
  temporaryId?: () => string;
  rename?: (from: string, to: string) => Promise<void>;
  managedRoot?: string;
  link?: (existingPath: string, newPath: string) => Promise<void>;
  copyFile?: (from: string, to: string, mode?: number) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
}

type AtomicWriteOptions = BaseAtomicWriteOptions &
  (
    | {
        refuseUnmanagedTarget: true;
        managedRoot: string;
        stored: StoredManagementRecord | undefined;
      }
    | { refuseUnmanagedTarget?: false }
  );

async function hasSameContent(
  path: string,
  content: string,
  read: (path: string) => Promise<string>,
): Promise<boolean> {
  try {
    return (await read(path)) === content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeTemporaryFile(
  path: string,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  try {
    await remove(path);
  } catch {
    try {
      await remove(path);
    } catch {
      // The target is already durable. Leaving an internal temp is safer than
      // reporting the write as failed before its DB record can be persisted.
    }
  }
}

export async function writeMarkdownAtomic(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<'written' | 'unchanged' | 'skipped'> {
  if (options.dryRun) return 'skipped';
  if (options.managedRoot) {
    await assertNoSymlinkEscape(
      {
        async isSymbolicLink(candidate) {
          try {
            return (await lstat(candidate)).isSymbolicLink();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              return false;
            throw error;
          }
        },
      },
      options.managedRoot,
      path,
    );
  }

  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${(options.temporaryId ?? randomUUID)()}.tmp`,
  );
  const read = options.readFile ?? ((candidate) => readFile(candidate, 'utf8'));
  try {
    let claimExclusively = false;
    if (options.refuseUnmanagedTarget) {
      try {
        const target = await lstat(path);
        if (!target.isFile()) {
          throw new DomainError(
            'safety',
            'Markdown target is not a regular file; inspect or remove the conflicting path before syncing',
          );
        }
        const currentContent = await read(path);
        if (
          !inspectManagementMarker({
            managedRoot: options.managedRoot,
            filePath: path,
            content: currentContent,
            stored: options.stored,
          }).managed
        ) {
          throw new DomainError(
            'safety',
            'Markdown target is not managed by notion-to-obsidian; inspect or remove the conflicting path before syncing',
          );
        }
        if (currentContent === content) return 'unchanged';
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          claimExclusively = true;
        } else {
          throw cause;
        }
      }
    } else if (await hasSameContent(path, content, read)) {
      return 'unchanged';
    }

    await mkdir(directory, { recursive: true });
    const file = await open(temporaryPath, 'wx');
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    if (claimExclusively) {
      await claimTargetExclusively({
        sourcePath: temporaryPath,
        targetPath: path,
        targetExistsMessage:
          'Markdown target already exists; inspect or remove the conflicting path before syncing',
        ...(options.link ? { link: options.link } : {}),
        ...(options.copyFile ? { copyFile: options.copyFile } : {}),
      });
      await removeTemporaryFile(temporaryPath, options.unlink ?? unlink);
    } else {
      await (options.rename ?? rename)(temporaryPath, path);
    }
    return 'written';
  } catch (cause) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Preserve the primary write error when best-effort cleanup also fails.
    }
    if (cause instanceof DomainError) throw cause;
    const message = cause instanceof Error ? cause.message : 'unknown error';
    throw new InfraError('storage', `Atomic write failed: ${message}`, {
      cause,
    });
  }
}
