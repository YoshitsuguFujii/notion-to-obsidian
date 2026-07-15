import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError, InfraError } from '../errors.js';

interface FileLockOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  dryRun?: boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function lockPid(content: string): number | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && 'pid' in value) {
      const pid = (value as { pid?: unknown }).pid;
      return Number.isSafeInteger(pid) && Number(pid) > 0
        ? Number(pid)
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class FileLock {
  readonly #path: string;
  readonly #pid: number;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #dryRun: boolean;
  #acquired = false;

  constructor(path: string, options: FileLockOptions = {}) {
    this.#path = path;
    this.#pid = options.pid ?? process.pid;
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#dryRun = options.dryRun ?? false;
  }

  async acquire(): Promise<void> {
    if (this.#dryRun) return;
    await mkdir(dirname(this.#path), { recursive: true });
    for (;;) {
      try {
        const file = await open(this.#path, 'wx');
        try {
          await file.writeFile(
            JSON.stringify({
              pid: this.#pid,
              acquiredAt: new Date().toISOString(),
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        this.#acquired = true;
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new InfraError('storage', 'Lock file could not be acquired', {
            cause,
          });
        }
        const existingPid = lockPid(await readFile(this.#path, 'utf8'));
        if (!existingPid || this.#isProcessAlive(existingPid)) {
          throw new DomainError(
            'safety',
            'Another sync process holds the lock',
          );
        }
        try {
          await unlink(this.#path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new InfraError('storage', 'Stale lock could not be removed', {
              cause: unlinkError,
            });
          }
        }
      }
    }
  }

  async release(): Promise<void> {
    if (this.#dryRun || !this.#acquired) return;
    try {
      const existingPid = lockPid(await readFile(this.#path, 'utf8'));
      if (existingPid === this.#pid) await unlink(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      this.#acquired = false;
    }
  }
}
