import * as initial from './001-initial.js';
import * as assetCacheStatus from './002-asset-cache-status.js';

export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [initial, assetCacheStatus];
