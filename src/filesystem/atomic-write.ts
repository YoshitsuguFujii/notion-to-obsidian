import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { InfraError } from '../errors.js';
import { assertNoSymlinkEscape } from './safe-path.js';

interface AtomicWriteOptions {
  dryRun?: boolean;
  temporaryId?: () => string;
  rename?: (from: string, to: string) => Promise<void>;
  managedRoot?: string;
}

async function hasSameContent(path: string, content: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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
  if (await hasSameContent(path, content)) return 'unchanged';

  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${(options.temporaryId ?? randomUUID)()}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true });
    const file = await open(temporaryPath, 'wx');
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await (options.rename ?? rename)(temporaryPath, path);
    return 'written';
  } catch (cause) {
    await rm(temporaryPath, { force: true });
    const message = cause instanceof Error ? cause.message : 'unknown error';
    throw new InfraError('storage', `Atomic write failed: ${message}`, {
      cause,
    });
  }
}
