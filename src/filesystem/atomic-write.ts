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
import {
  inspectUnsupportedSidecarTarget,
  type StoredPageIdentity,
} from './unsupported-sidecar-target.js';

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

type ManagedTargetOwnership =
  | {
      kind: 'markdown-marker';
      stored: StoredManagementRecord | undefined;
    }
  | {
      kind: 'unsupported-sidecar';
      expectedPageId: string;
      expectedSidecarId: string;
      storedPage: StoredPageIdentity | undefined;
    };

type AtomicWriteOptions = BaseAtomicWriteOptions &
  (
    | { ownership: ManagedTargetOwnership; managedRoot: string }
    | { ownership?: undefined }
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
            const message =
              error instanceof Error ? error.message : 'unknown error';
            throw new InfraError(
              'storage',
              `Path inspection failed: ${message}`,
              { cause: error },
            );
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
    if (options.ownership) {
      const targetLabel =
        options.ownership.kind === 'markdown-marker'
          ? 'Markdown target'
          : 'Unsupported sidecar target';
      let inspection:
        | { kind: 'absent' | 'unmanaged' | 'not-regular' | 'unreadable' }
        | { kind: 'owned'; content: string };
      if (options.ownership.kind === 'unsupported-sidecar') {
        inspection = await inspectUnsupportedSidecarTarget(
          {
            managedRoot: options.managedRoot,
            targetPath: path,
            expectedPageId: options.ownership.expectedPageId,
            expectedSidecarId: options.ownership.expectedSidecarId,
            storedPage: options.ownership.storedPage,
          },
          { readFile: read },
        );
      } else {
        try {
          const target = await lstat(path);
          if (!target.isFile()) {
            inspection = { kind: 'not-regular' };
          } else {
            const currentContent = await read(path);
            inspection = inspectManagementMarker({
              managedRoot: options.managedRoot,
              filePath: path,
              content: currentContent,
              stored: options.ownership.stored,
            }).managed
              ? { kind: 'owned', content: currentContent }
              : { kind: 'unmanaged' };
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            inspection = { kind: 'absent' };
          } else {
            throw cause;
          }
        }
      }

      if (inspection.kind === 'absent') {
        claimExclusively = true;
      } else if (inspection.kind === 'not-regular') {
        throw new DomainError(
          'safety',
          `${targetLabel} is not a regular file; inspect or remove the conflicting path before syncing`,
        );
      } else if (inspection.kind === 'unmanaged') {
        throw new DomainError(
          'safety',
          `${targetLabel} is not managed by notion-to-obsidian; inspect or remove the conflicting path before syncing`,
        );
      } else if (inspection.kind === 'unreadable') {
        throw new InfraError(
          'storage',
          `${targetLabel} cannot be read; inspect its permissions before syncing`,
        );
      } else if (inspection.content === content) {
        return 'unchanged';
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
        targetExistsMessage: `${
          options.ownership?.kind === 'unsupported-sidecar'
            ? 'Unsupported sidecar target'
            : 'Markdown target'
        } already exists; inspect or remove the conflicting path before syncing`,
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
    if (cause instanceof DomainError || cause instanceof InfraError)
      throw cause;
    const message = cause instanceof Error ? cause.message : 'unknown error';
    throw new InfraError('storage', `Atomic write failed: ${message}`, {
      cause,
    });
  }
}
