import { posix } from 'node:path';
import type { PlannedResourcePath } from '../domain/path-plan.js';
import { DomainError } from '../errors.js';
import { joinManagedPath } from '../filesystem/safe-path.js';
import { outputPathCollisionKey } from './output-path-collision-key.js';

interface StoredOutputPath {
  localPath?: string;
}

interface OutputPathAllocationOptions {
  paths: readonly PlannedResourcePath[];
  existingById: ReadonlyMap<string, StoredOutputPath>;
  managedRoot: string;
  exists(path: string): Promise<boolean>;
}

export interface OutputPathAllocationWarning {
  notionId: string;
  message: string;
}

export interface OutputPathAllocation {
  paths: PlannedResourcePath[];
  warnings: OutputPathAllocationWarning[];
}

function normalizedPath(path: string): string {
  return path.split('\\').join('/');
}

function collisionPath(path: string, notionId: string): string {
  const extension = posix.extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  const shortId = notionId.replaceAll('-', '').slice(0, 8);
  return `${stem}--${shortId}${extension}`;
}

function plannedOwners(
  paths: readonly PlannedResourcePath[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const owners = new Map<string, Set<string>>();
  for (const path of paths) {
    const key = outputPathCollisionKey(path.expectedPath);
    const pathOwners = owners.get(key) ?? new Set<string>();
    pathOwners.add(path.notionId);
    owners.set(key, pathOwners);
  }
  return owners;
}

function belongsToAnotherResource(
  owners: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
  notionId: string,
): boolean {
  return [...(owners.get(key) ?? [])].some((owner) => owner !== notionId);
}

export async function allocateOutputPaths(
  options: OutputPathAllocationOptions,
): Promise<OutputPathAllocation> {
  const originalOwners = plannedOwners(options.paths);
  const assignedOwners = new Map<string, Set<string>>();
  const warnings: OutputPathAllocationWarning[] = [];
  const paths: PlannedResourcePath[] = [];

  const isLocalCollision = async (
    path: string,
    currentPath: string,
  ): Promise<boolean> =>
    path !== currentPath &&
    (await options.exists(joinManagedPath(options.managedRoot, path)));

  for (const planned of options.paths) {
    const expectedPath = normalizedPath(planned.expectedPath);
    const stored = options.existingById.get(planned.notionId);
    const currentPath = normalizedPath(stored?.localPath ?? '');
    let allocatedPath = expectedPath;

    if (currentPath && currentPath !== expectedPath) {
      const targetCollision =
        belongsToAnotherResource(
          originalOwners,
          outputPathCollisionKey(expectedPath),
          planned.notionId,
        ) ||
        belongsToAnotherResource(
          assignedOwners,
          outputPathCollisionKey(expectedPath),
          planned.notionId,
        ) ||
        (await isLocalCollision(expectedPath, currentPath));

      if (targetCollision) {
        allocatedPath = collisionPath(expectedPath, planned.notionId);
        const fallbackCollision =
          belongsToAnotherResource(
            originalOwners,
            outputPathCollisionKey(allocatedPath),
            planned.notionId,
          ) ||
          belongsToAnotherResource(
            assignedOwners,
            outputPathCollisionKey(allocatedPath),
            planned.notionId,
          ) ||
          (await isLocalCollision(allocatedPath, currentPath));
        if (fallbackCollision) {
          throw new DomainError(
            'safety',
            'Collision fallback path already exists',
          );
        }
        warnings.push({
          notionId: planned.notionId,
          message: 'Unmanaged target collision used a deterministic fallback',
        });
      }
    }

    const assignedKey = outputPathCollisionKey(allocatedPath);
    const owners = assignedOwners.get(assignedKey) ?? new Set<string>();
    owners.add(planned.notionId);
    assignedOwners.set(assignedKey, owners);
    const extension = posix.extname(allocatedPath);
    paths.push(
      allocatedPath === expectedPath
        ? planned
        : {
            ...planned,
            expectedPath: allocatedPath,
            resolvedFilename: posix.basename(allocatedPath, extension),
          },
    );
  }

  return { paths, warnings };
}
