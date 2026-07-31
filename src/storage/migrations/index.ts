import * as initial from './001-initial.js';
import * as assetCacheStatus from './002-asset-cache-status.js';
import * as resourceProvenance from './003-resource-provenance.js';

export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  initial,
  assetCacheStatus,
  resourceProvenance,
].sort((a, b) => a.version - b.version);
