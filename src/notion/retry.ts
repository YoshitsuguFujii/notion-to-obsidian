import { InfraError } from '../errors.js';

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

interface Failure {
  status?: number;
  code?: string;
  message?: string;
  headers?: Record<string, string>;
}
const retryableStatuses = new Set([429, 529, 500, 502, 503, 504]);

function classify(error: Failure): InfraError {
  const cause = {
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
  };
  if (error.status === 401)
    return new InfraError('authentication', 'Notion authentication failed', {
      cause,
    });
  if (error.status === 403)
    return new InfraError('permission', 'Notion permission denied', {
      cause,
    });
  if (error.status === 400)
    return new InfraError('validation', 'Notion request validation failed', {
      cause,
    });
  if (error.status === 429)
    return new InfraError('rate_limited', 'Notion rate limit exceeded', {
      cause,
    });
  if (error.status && error.status >= 500)
    return new InfraError('service_unavailable', 'Notion service unavailable', {
      cause,
    });
  return new InfraError('network', 'Notion network request failed', {
    cause,
  });
}

function retryable(error: Failure): boolean {
  return (
    (error.status !== undefined && retryableStatuses.has(error.status)) ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code ?? '')
  );
}

export function createRetriableExecutor(options: RetryOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maximumDelayMs = options.maximumDelayMs ?? 30_000;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  return async function execute<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (caught) {
        const error = (caught ?? {}) as Failure;
        if (!retryable(error) || attempt === maxAttempts) throw classify(error);
        const retryAfter = Number(error.headers?.['retry-after']);
        const delay =
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : Math.min(maximumDelayMs, baseDelayMs * 2 ** (attempt - 1)) *
              (0.5 + random() / 2);
        await sleep(delay);
      }
    }
    throw new InfraError('network', 'Notion request failed');
  };
}
