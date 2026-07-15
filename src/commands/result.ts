import { DomainError } from '../errors.js';

export interface CommandResult {
  ok: boolean;
  partial?: boolean;
  safetyStopped?: boolean;
  verifyMismatch?: boolean;
  lockFailed?: boolean;
  [key: string]: unknown;
}

export function exitCodeFor(
  result?: CommandResult,
  error?: unknown,
): 0 | 1 | 2 | 3 | 4 | 5 {
  if (error) {
    if (
      error instanceof DomainError &&
      error.category === 'safety' &&
      /lock/iu.test(error.message)
    )
      return 5;
    if (error instanceof DomainError && error.category === 'safety') return 3;
    return 1;
  }
  if (!result || (!result.ok && result.lockFailed)) return 5;
  if (!result.ok && result.verifyMismatch) return 4;
  if (!result.ok && result.safetyStopped) return 3;
  if (!result.ok && result.partial) return 2;
  return result.ok ? 0 : 1;
}
