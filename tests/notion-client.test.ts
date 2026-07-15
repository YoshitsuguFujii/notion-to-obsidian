import { describe, expect, it, vi } from 'vitest';
import { createRetriableExecutor } from '../src/notion/retry.js';
import { RequestScheduler } from '../src/notion/client.js';

describe('Notion request policy', () => {
  it('Retry-After を尊重して retryable failure を有限回再試行する', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '2' } })
      .mockResolvedValue('ok');
    const execute = createRetriableExecutor({ sleep, random: () => 0 });

    await expect(execute(operation)).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 400])('HTTP %s は再試行せず分類する', async (status) => {
    const operation = vi.fn().mockRejectedValue({ status, message: 'denied' });
    const execute = createRetriableExecutor({ sleep: () => Promise.resolve() });

    await expect(execute(operation)).rejects.toMatchObject({
      category:
        status === 401
          ? 'authentication'
          : status === 403
            ? 'permission'
            : 'validation',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('最大試行回数を超えて再試行しない', async () => {
    const operation = vi.fn().mockRejectedValue({ code: 'ECONNRESET' });
    const execute = createRetriableExecutor({
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    await expect(execute(operation)).rejects.toMatchObject({
      category: 'network',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('外部エラーの機密情報を分類後の例外 cause に保持しない', async () => {
    const execute = createRetriableExecutor({
      sleep: () => Promise.resolve(),
    });

    const failure = execute(() =>
      Promise.reject(
        Object.assign(new Error('Bearer secret-token'), {
          status: 403,
          request: { authorization: 'Bearer secret-token' },
        }),
      ),
    );

    const error = await failure.catch((caught: unknown) => caught);

    expect(
      JSON.stringify((error as Error & { cause?: unknown }).cause),
    ).not.toContain('secret-token');
  });
});

describe('Notion request throttle', () => {
  it('設定された request rate の間隔を空ける', async () => {
    let now = 0;
    const waits: number[] = [];
    const scheduler = new RequestScheduler({
      requestRatePerSecond: 2.5,
      concurrency: 2,
      now: () => now,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });

    await scheduler.run(() => Promise.resolve('first'));
    await scheduler.run(() => Promise.resolve('second'));

    expect(waits).toEqual([400]);
  });

  it('同時実行数を設定値以下に保つ', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const scheduler = new RequestScheduler({
      requestRatePerSecond: 1000,
      concurrency: 2,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    const operation = () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
    };

    const requests = [
      scheduler.run(operation),
      scheduler.run(operation),
      scheduler.run(operation),
    ];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();
    await Promise.all(requests);

    expect(maximumActive).toBe(2);
  });
});
