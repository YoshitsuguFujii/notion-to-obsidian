export type SyncMode = 'full' | 'incremental' | 'page' | 'root';
export interface NewSyncRun {
  runId: string;
  startedAt: string;
  mode: SyncMode;
  configHash: string;
  apiVersion: string;
  toolVersion: string;
  transformVersion: string;
}
export interface SyncRun extends NewSyncRun {
  finishedAt?: string;
  success?: boolean;
  partial: boolean;
  counts?: SyncRunCounts;
}
export interface SyncRunCounts {
  create: number;
  update: number;
  move: number;
  trash: number;
  unchanged: number;
  error: number;
}
export interface SyncRunCompletion {
  runId: string;
  finishedAt: string;
  success: boolean;
  partial: boolean;
  counts: SyncRunCounts;
}
export interface AssetState {
  stableKey: string;
  pageId: string;
  blockId: string;
  localPath: string;
  originalName: string;
  mimeType?: string;
  size?: number;
  contentHash?: string;
  etag?: string;
  lastModified?: string;
  lastSeenRunId?: string;
  fetchedAt?: string;
}
export interface WarningState {
  runId: string;
  resourceId?: string;
  warningType: string;
  message: string;
  createdAt: string;
}

export interface RootState {
  rootPageId: string;
  localName: string;
  lastSuccessfulCensus?: string;
  status: 'complete' | 'partial';
  lastSeenRunId?: string;
  lastErrorCategory?: string;
  lastErrorAt?: string;
}

export interface ResourceState {
  notionId: string;
  objectType: 'page' | 'database';
  rootId: string;
  parentId?: string;
  title: string;
  localPath?: string;
  expectedPath: string;
  resolvedFilename: string;
  lastEditedTime: string;
  lastSeenRunId?: string;
  inTrash: boolean;
  status: 'active' | 'tombstoned' | 'missing';
  createdAt: string;
  updatedAt: string;
  contentHash?: string;
  structureHash?: string;
  missingCount?: number;
  tombstonedAt?: string;
  trashReason?: string;
}

export interface StoredResource extends ResourceState {
  contentHash?: string;
  structureHash?: string;
  missingCount: number;
  tombstonedAt?: string;
  trashReason?: string;
}

export interface StateStore {
  beginRun(run: NewSyncRun): void;
  getRun(runId: string): SyncRun | undefined;
  finishRun(completion: SyncRunCompletion): void;
  getLatestRun(): SyncRun | undefined;
  upsertRoot(root: RootState): void;
  getRoot(rootPageId: string): RootState | undefined;
  listRoots(): RootState[];
  upsertResource(resource: ResourceState): void;
  updateResourceMissingState(
    notionId: string,
    state: { missingCount: number; status?: ResourceState['status'] },
  ): void;
  getResource(notionId: string): StoredResource | undefined;
  listResources(): StoredResource[];
  listUnfinishedRuns(): SyncRun[];
  upsertAsset(asset: AssetState): void;
  getAsset(stableKey: string): AssetState | undefined;
  listAssets(): AssetState[];
  insertWarning(warning: WarningState): void;
  listWarnings(runId?: string): WarningState[];
  transaction<T>(work: () => T): T;
  close(): void;
}
