import { ClientErrorCode } from '@notionhq/client';
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
  // Notion は、Integration が未共有のページ/データベース/ブロックに対しても
  // 403ではなく404（code: object_not_found）を返す（存在有無の漏洩を避ける
  // ための仕様）。汎用のnetwork分類に落とすと「回線の問題」と誤解されるため、
  // 権限/共有の問題として明示的に分類する。retrievePage/retrieveDatabase/
  // listBlockChildren等いずれの経路でも起こりうるため、対象種別を断定しない。
  if (error.status === 404)
    return new InfraError(
      'permission',
      'Notion object was not found or is not shared with this integration. Connect the integration to it in Notion, then retry.',
      { cause },
    );
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

// ClientErrorCode.RequestTimeoutは@notionhq/client（RequestTimeoutError）が
// クライアント側タイムアウト時に返すコード。HTTPレスポンス自体が返っていない
// ためerror.statusを持たず、既存のHTTPステータス判定では捕捉できない。
const retryableCodes: Set<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  ClientErrorCode.RequestTimeout,
]);

function retryable(error: Failure): boolean {
  return (
    (error.status !== undefined && retryableStatuses.has(error.status)) ||
    retryableCodes.has(error.code ?? '')
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
