import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { InfraError } from '../errors.js';
import { joinManagedPath, sanitizePathSegment } from './safe-path.js';

export interface StoredPageIdentity {
  notionId: string;
}

export type UnsupportedSidecarTargetInspection =
  | { kind: 'absent' }
  | { kind: 'owned'; content: string }
  | { kind: 'unmanaged' }
  | { kind: 'not-regular' }
  | { kind: 'unreadable' };

interface UnsupportedSidecarTargetOptions {
  managedRoot: string;
  targetPath: string;
  expectedPageId: string;
  expectedSidecarId: string;
  storedPage: StoredPageIdentity | undefined;
}

interface UnsupportedSidecarTargetFileSystem {
  lstat(path: string): Promise<{ isFile(): boolean }>;
  readFile(path: string): Promise<string>;
}

const defaultFileSystem: UnsupportedSidecarTargetFileSystem = {
  lstat,
  readFile: (path) => readFile(path, 'utf8'),
};

export function unsupportedSidecarPath(
  managedRoot: string,
  pageId: string,
  sidecarId: string,
): string {
  return joinManagedPath(
    managedRoot,
    '_unsupported',
    sanitizePathSegment(pageId, pageId),
    `${sanitizePathSegment(sidecarId, sidecarId)}.json`,
  );
}

function hasOwnedShape(value: unknown, expectedSidecarId: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    keys.every((key) => ['type', 'id', 'payload'].includes(key)) &&
    typeof record.type === 'string' &&
    typeof record.id === 'string' &&
    Object.hasOwn(record, 'payload') &&
    record.id === expectedSidecarId
  );
}

export async function inspectUnsupportedSidecarTarget(
  options: UnsupportedSidecarTargetOptions,
  fileSystemOverrides: Partial<UnsupportedSidecarTargetFileSystem> = {},
): Promise<UnsupportedSidecarTargetInspection> {
  const fileSystem = { ...defaultFileSystem, ...fileSystemOverrides };
  let target: { isFile(): boolean };
  try {
    target = await fileSystem.lstat(options.targetPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    const message = cause instanceof Error ? cause.message : 'unknown error';
    throw new InfraError(
      'storage',
      `Unsupported sidecar inspection failed: ${message}`,
      { cause },
    );
  }
  if (!target.isFile()) return { kind: 'not-regular' };

  let content: string;
  try {
    content = await fileSystem.readFile(options.targetPath);
  } catch {
    return { kind: 'unreadable' };
  }

  const expectedPath = unsupportedSidecarPath(
    options.managedRoot,
    options.expectedPageId,
    options.expectedSidecarId,
  );
  if (
    resolve(options.targetPath) !== resolve(expectedPath) ||
    options.storedPage?.notionId !== options.expectedPageId
  ) {
    return { kind: 'unmanaged' };
  }

  try {
    if (!hasOwnedShape(JSON.parse(content), options.expectedSidecarId)) {
      return { kind: 'unmanaged' };
    }
  } catch {
    return { kind: 'unmanaged' };
  }
  return { kind: 'owned', content };
}
