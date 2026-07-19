import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface FileIdentityStat extends FileIdentity {
  isFile(): boolean;
}

export interface HashFileHandle {
  stat(options: { bigint: true }): Promise<FileIdentityStat>;
  createReadStream(options: {
    autoClose: false;
    start: number;
  }): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

export interface HashFileWithIdentityDependencies {
  noFollowFlag?: number | undefined;
  open?(path: string, flags: number): Promise<HashFileHandle>;
  lstat?(path: string): Promise<FileIdentityStat>;
}

export type FileIdentityAtPathResult =
  | { kind: 'matched' }
  | { kind: 'changed' }
  | { kind: 'io-error'; cause: unknown };

// phase と reason は、失敗が起きた検査段階を診断できるよう分類結果に保持する。
export type HashFileWithIdentityResult =
  | { kind: 'hashed'; hash: string; identity: FileIdentity }
  | { kind: 'absent' }
  | { kind: 'not-regular'; reason: 'symlink' | 'other' }
  | { kind: 'changed'; reason: 'during-read' | 'path-after-read' }
  | { kind: 'size-mismatch' }
  | { kind: 'unsupported-no-follow' }
  | {
      kind: 'io-error';
      phase:
        | 'open'
        | 'stat-before'
        | 'read'
        | 'stat-after'
        | 'path-stat-after'
        | 'close';
      cause: unknown;
    };

const unsupportedNoFollowCodes = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

function errorCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException).code;
}

function identityOf(stat: FileIdentityStat): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function fileIdentityMatches(
  stat: FileIdentityStat,
  expected: FileIdentity,
): boolean {
  return (
    stat.isFile() &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs &&
    stat.ctimeNs === expected.ctimeNs
  );
}

function isSafetyResult(result: HashFileWithIdentityResult): boolean {
  return result.kind === 'not-regular' || result.kind === 'changed';
}

function configuredNoFollowFlag(
  dependencies: HashFileWithIdentityDependencies,
): number | undefined {
  if ('noFollowFlag' in dependencies) return dependencies.noFollowFlag;
  return (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
}

async function nodeLstat(path: string): Promise<FileIdentityStat> {
  return lstat(path, { bigint: true });
}

export async function inspectFileIdentityAtPath(
  path: string,
  expected: FileIdentity,
  dependencies: Pick<HashFileWithIdentityDependencies, 'lstat'> = {},
): Promise<FileIdentityAtPathResult> {
  try {
    const current = await (dependencies.lstat ?? nodeLstat)(path);
    return fileIdentityMatches(current, expected)
      ? { kind: 'matched' }
      : { kind: 'changed' };
  } catch (cause) {
    return errorCode(cause) === 'ENOENT'
      ? { kind: 'changed' }
      : { kind: 'io-error', cause };
  }
}

async function inspectOpenedFile(
  path: string,
  expectedSizes: readonly number[],
  handle: HashFileHandle,
  inspectPath: (path: string) => Promise<FileIdentityStat>,
): Promise<HashFileWithIdentityResult> {
  let before: FileIdentityStat;
  try {
    before = await handle.stat({ bigint: true });
  } catch (cause) {
    return { kind: 'io-error', phase: 'stat-before', cause };
  }
  if (!before.isFile()) return { kind: 'not-regular', reason: 'other' };

  const expected = expectedSizes.map((size) => BigInt(size));
  if (!expected.some((size) => size === before.size)) {
    return { kind: 'size-mismatch' };
  }

  const hash = createHash('sha256');
  try {
    const content = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of content) hash.update(chunk);
  } catch (cause) {
    return { kind: 'io-error', phase: 'read', cause };
  }

  let after: FileIdentityStat;
  try {
    after = await handle.stat({ bigint: true });
  } catch (cause) {
    return { kind: 'io-error', phase: 'stat-after', cause };
  }
  if (!fileIdentityMatches(after, identityOf(before))) {
    return { kind: 'changed', reason: 'during-read' };
  }

  let currentPath: FileIdentityStat;
  try {
    currentPath = await inspectPath(path);
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') {
      return { kind: 'changed', reason: 'path-after-read' };
    }
    return { kind: 'io-error', phase: 'path-stat-after', cause };
  }
  if (!fileIdentityMatches(currentPath, identityOf(after))) {
    return { kind: 'changed', reason: 'path-after-read' };
  }

  return {
    kind: 'hashed',
    hash: hash.digest('hex'),
    identity: identityOf(after),
  };
}

export async function hashFileWithIdentity(
  path: string,
  expectedSizes: readonly number[],
  dependencies: HashFileWithIdentityDependencies = {},
): Promise<HashFileWithIdentityResult> {
  const noFollowFlag = configuredNoFollowFlag(dependencies);
  if (noFollowFlag === undefined) return { kind: 'unsupported-no-follow' };

  const openFile = dependencies.open
    ? (candidate: string, flags: number) => dependencies.open!(candidate, flags)
    : (candidate: string, flags: number) => open(candidate, flags);
  const inspectPath = dependencies.lstat
    ? (candidate: string) => dependencies.lstat!(candidate)
    : nodeLstat;
  let handle: HashFileHandle;
  try {
    handle = await openFile(
      path,
      constants.O_RDONLY | noFollowFlag | constants.O_NONBLOCK,
    );
  } catch (cause) {
    const code = errorCode(cause);
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'ELOOP') {
      return { kind: 'not-regular', reason: 'symlink' };
    }
    if (code && unsupportedNoFollowCodes.has(code)) {
      return { kind: 'unsupported-no-follow' };
    }
    return { kind: 'io-error', phase: 'open', cause };
  }

  let result: HashFileWithIdentityResult | undefined;
  try {
    result = await inspectOpenedFile(path, expectedSizes, handle, inspectPath);
  } finally {
    try {
      await handle.close();
    } catch (cause) {
      if (result !== undefined && !isSafetyResult(result)) {
        result = { kind: 'io-error', phase: 'close', cause };
      }
    }
  }
  return result;
}
