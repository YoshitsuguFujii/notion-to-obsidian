import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { DomainError, InfraError } from '../errors.js';
import { claimTargetExclusively } from '../filesystem/exclusive-target-claim.js';
import { buildAssetPath } from './mapping.js';
import type { AssetState } from '../storage/state-store.js';

export interface PlannedAssetTarget {
  stableKey: string;
  pageId: string;
  blockId: string;
  localPath: string;
  absolutePath: string;
  originalName: string;
  previous: AssetState | undefined;
}

export function assertAssetTargetIdentity(target: PlannedAssetTarget): void {
  const previous = target.previous;
  if (!previous) return;
  const expectedPath = buildAssetPath(
    target.pageId,
    target.blockId,
    previous.originalName,
  );
  if (
    previous.stableKey !== target.stableKey ||
    previous.pageId !== target.pageId ||
    previous.blockId !== target.blockId ||
    previous.localPath !== expectedPath ||
    target.localPath !== previous.localPath
  ) {
    throw new DomainError(
      'safety',
      'Stored asset identity or canonical path is inconsistent',
    );
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>)
      hash.update(chunk);
    return hash.digest('hex');
  } catch (cause) {
    throw new InfraError('storage', 'Asset target could not be read', {
      cause,
    });
  }
}

async function targetStat(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InfraError('storage', 'Asset target could not be inspected', {
      cause,
    });
  }
}

function targetConflict(): DomainError {
  return new DomainError(
    'safety',
    'Asset target exists but its ownership cannot be established',
  );
}

export async function inspectAssetTargetForPlan(
  target: PlannedAssetTarget,
): Promise<'ready' | 'deferred'> {
  assertAssetTargetIdentity(target);
  const current = await targetStat(target.absolutePath);
  if (!current) return 'ready';
  if (!current.isFile()) throw targetConflict();
  const previous = target.previous;
  if (
    previous?.contentHash &&
    previous.size !== undefined &&
    current.size === previous.size &&
    (await hashFile(target.absolutePath)) === previous.contentHash
  ) {
    return 'ready';
  }
  return 'deferred';
}

export async function commitAssetDownload(input: {
  target: PlannedAssetTarget;
  temporaryPath: string;
  desiredHash: string;
  desiredSize: number;
}): Promise<void> {
  const { target, temporaryPath, desiredHash, desiredSize } = input;
  assertAssetTargetIdentity(target);
  try {
    const current = await targetStat(target.absolutePath);
    if (!current) {
      try {
        await claimTargetExclusively({
          sourcePath: temporaryPath,
          targetPath: target.absolutePath,
          targetExistsMessage: 'Asset target was created concurrently',
        });
      } catch (cause) {
        if (cause instanceof DomainError) throw cause;
        throw new InfraError('storage', 'Asset target could not be claimed', {
          cause,
        });
      }
      try {
        await rm(temporaryPath, { force: true });
      } catch (cause) {
        throw new InfraError('storage', 'Asset temporary file cleanup failed', {
          cause,
        });
      }
      return;
    }
    if (!current.isFile()) throw targetConflict();

    const previous = target.previous;
    const couldMatchDesired = current.size === desiredSize;
    const couldMatchPrevious =
      previous?.contentHash !== undefined &&
      previous.size !== undefined &&
      current.size === previous.size;
    if (!couldMatchDesired && !couldMatchPrevious) throw targetConflict();

    const diskHash = await hashFile(target.absolutePath);
    if (couldMatchDesired && diskHash === desiredHash) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (cause) {
        throw new InfraError('storage', 'Asset temporary file cleanup failed', {
          cause,
        });
      }
      return;
    }
    if (couldMatchPrevious && diskHash === previous?.contentHash) {
      try {
        await rename(temporaryPath, target.absolutePath);
      } catch (cause) {
        throw new InfraError('storage', 'Managed asset update failed', {
          cause,
        });
      }
      return;
    }
    throw targetConflict();
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Cleanup is best effort so the ownership/storage failure remains primary.
    }
    throw error;
  }
}
