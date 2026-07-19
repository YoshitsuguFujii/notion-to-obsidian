import { lstat, rename, rm } from 'node:fs/promises';
import { DomainError, InfraError } from '../errors.js';
import { claimTargetExclusively } from '../filesystem/exclusive-target-claim.js';
import {
  hashFileWithIdentity,
  inspectFileIdentityAtPath,
  type FileIdentity,
  type HashFileWithIdentityDependencies,
  type HashFileWithIdentityResult,
} from '../filesystem/hash-file-with-identity.js';
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

async function targetStat(
  path: string,
  dependencies: Pick<HashFileWithIdentityDependencies, 'lstat'> = {},
) {
  try {
    return await (dependencies.lstat ?? ((candidate) => lstat(candidate)))(
      path,
    );
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

function safeOpenUnavailable(): DomainError {
  return new DomainError(
    'safety',
    'Asset target cannot be verified because safe file opening is unavailable; use an operating system and filesystem that support O_NOFOLLOW',
  );
}

function assetReadFailure(cause: unknown): InfraError {
  return new InfraError('storage', 'Asset target could not be read', { cause });
}

function requireStableHash(
  result: HashFileWithIdentityResult,
): Extract<HashFileWithIdentityResult, { kind: 'hashed' }> {
  if (result.kind === 'hashed') return result;
  if (result.kind === 'unsupported-no-follow') throw safeOpenUnavailable();
  if (result.kind === 'io-error') throw assetReadFailure(result.cause);
  throw targetConflict();
}

async function assertIdentityUnchanged(
  path: string,
  identity: FileIdentity,
  dependencies: Pick<HashFileWithIdentityDependencies, 'lstat'>,
): Promise<void> {
  const inspection = await inspectFileIdentityAtPath(
    path,
    identity,
    dependencies,
  );
  if (inspection.kind === 'changed') throw targetConflict();
  if (inspection.kind === 'io-error') {
    throw new InfraError('storage', 'Asset target could not be inspected', {
      cause: inspection.cause,
    });
  }
}

export async function inspectAssetTargetForPlan(
  target: PlannedAssetTarget,
  dependencies: HashFileWithIdentityDependencies = {},
): Promise<'ready' | 'deferred'> {
  assertAssetTargetIdentity(target);
  const previous = target.previous;
  if (!previous?.contentHash || previous.size === undefined) {
    const current = await targetStat(target.absolutePath, dependencies);
    if (!current) return 'ready';
    if (!current.isFile()) throw targetConflict();
    return 'deferred';
  }
  const result = await hashFileWithIdentity(
    target.absolutePath,
    [previous.size],
    dependencies,
  );
  if (result.kind === 'absent') return 'ready';
  if (result.kind === 'changed') return 'deferred';
  if (result.kind === 'size-mismatch') return 'deferred';
  if (result.kind === 'not-regular') throw targetConflict();
  if (result.kind === 'unsupported-no-follow') throw safeOpenUnavailable();
  if (result.kind === 'io-error') throw assetReadFailure(result.cause);
  return result.hash === previous.contentHash ? 'ready' : 'deferred';
}

export async function commitAssetDownload(
  input: {
    target: PlannedAssetTarget;
    temporaryPath: string;
    desiredHash: string;
    desiredSize: number;
  },
  dependencies: HashFileWithIdentityDependencies = {},
): Promise<void> {
  const { target, temporaryPath, desiredHash, desiredSize } = input;
  assertAssetTargetIdentity(target);
  try {
    const previous = target.previous;
    const expectedSizes = [
      desiredSize,
      ...(previous?.contentHash !== undefined && previous.size !== undefined
        ? [previous.size]
        : []),
    ];
    const inspection = await hashFileWithIdentity(
      target.absolutePath,
      expectedSizes,
      dependencies,
    );
    if (inspection.kind === 'absent') {
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
    const current = requireStableHash(inspection);
    const couldMatchDesired = current.identity.size === BigInt(desiredSize);
    const couldMatchPrevious =
      previous?.contentHash !== undefined &&
      previous.size !== undefined &&
      current.identity.size === BigInt(previous.size);

    if (couldMatchDesired && current.hash === desiredHash) {
      await assertIdentityUnchanged(
        target.absolutePath,
        current.identity,
        dependencies,
      );
      try {
        await rm(temporaryPath, { force: true });
      } catch (cause) {
        throw new InfraError('storage', 'Asset temporary file cleanup failed', {
          cause,
        });
      }
      return;
    }
    if (couldMatchPrevious && current.hash === previous?.contentHash) {
      await assertIdentityUnchanged(
        target.absolutePath,
        current.identity,
        dependencies,
      );
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
