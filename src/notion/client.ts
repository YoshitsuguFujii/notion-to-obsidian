import { Client } from '@notionhq/client';
import type { NotionClient } from './types.js';
import { createRetriableExecutor } from './retry.js';

interface ClientOptions {
  token: string;
  requestRatePerSecond?: number;
  concurrency?: number;
}

interface SchedulerOptions {
  requestRatePerSecond: number;
  concurrency: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class RequestScheduler {
  private active = 0;
  private nextSlot = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  constructor(options: SchedulerOptions) {
    this.intervalMs = 1000 / options.requestRatePerSecond;
    this.concurrency = options.concurrency;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    const now = this.now();
    const delay = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (delay > 0) await this.sleep(delay);
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class NotionSdkClient implements NotionClient {
  private readonly sdk: Client;
  private readonly gate: RequestScheduler;
  private readonly execute = createRetriableExecutor();
  constructor(options: ClientOptions) {
    this.sdk = new Client({ auth: options.token, notionVersion: '2026-03-11' });
    this.gate = new RequestScheduler({
      requestRatePerSecond: options.requestRatePerSecond ?? 2.5,
      concurrency: options.concurrency ?? 2,
    });
  }
  private request<T>(operation: () => Promise<T>): Promise<T> {
    return this.gate.run(() => this.execute(operation));
  }
  retrievePage(pageId: string) {
    return this.request(() => this.sdk.pages.retrieve({ page_id: pageId }));
  }
  retrieveMarkdown(pageId: string) {
    return this.request(() =>
      this.sdk.pages.retrieveMarkdown({ page_id: pageId }),
    );
  }
  listBlockChildren(blockId: string, cursor?: string) {
    return this.request(() =>
      this.sdk.blocks.children.list({
        block_id: blockId,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );
  }
  queryDataSource(dataSourceId: string, cursor?: string) {
    return this.request(() =>
      this.sdk.dataSources.query({
        data_source_id: dataSourceId,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );
  }
  search(cursor?: string) {
    return this.request(() =>
      this.sdk.search({ ...(cursor ? { start_cursor: cursor } : {}) }),
    );
  }
}
