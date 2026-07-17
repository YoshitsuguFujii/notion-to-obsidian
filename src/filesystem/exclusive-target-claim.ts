import {
  copyFile as nodeCopyFile,
  link as nodeLink,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { DomainError } from '../errors.js';

interface ExclusiveTargetClaimOptions {
  sourcePath: string;
  targetPath: string;
  targetExistsMessage: string;
  link?: (existingPath: string, newPath: string) => Promise<void>;
  copyFile?: (from: string, to: string, mode?: number) => Promise<void>;
}

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

function targetExistsError(message: string, cause: unknown): DomainError {
  return new DomainError('safety', message, { cause });
}

export async function claimTargetExclusively(
  options: ExclusiveTargetClaimOptions,
): Promise<void> {
  try {
    await (options.link ?? nodeLink)(options.sourcePath, options.targetPath);
  } catch (linkCause) {
    if (errorCode(linkCause) === 'EEXIST') {
      throw targetExistsError(options.targetExistsMessage, linkCause);
    }
    if (!copyFallbackCodes.has(errorCode(linkCause) ?? '')) throw linkCause;

    try {
      await (options.copyFile ?? nodeCopyFile)(
        options.sourcePath,
        options.targetPath,
        constants.COPYFILE_EXCL,
      );
    } catch (copyCause) {
      if (errorCode(copyCause) === 'EEXIST') {
        throw targetExistsError(options.targetExistsMessage, copyCause);
      }
      await rm(options.targetPath, { force: true });
      throw copyCause;
    }
  }
}
