import { createHash } from 'node:crypto';
import { access, lstat, readFile } from 'node:fs/promises';
import type { AppConfig } from '../config/index.js';
import {
  applyPlannedPageAssets,
  assertAssetPathSafe,
  planPageAssets,
  type PlannedPageAssets,
} from '../assets/processor.js';
import { inspectAssetTargetForPlan } from '../assets/target.js';
import type { DownloadResult } from '../assets/http-downloader.js';
import {
  planResourcePaths,
  type PlannedResourcePath,
} from '../domain/path-plan.js';
import { DomainError, InfraError } from '../errors.js';
import { writeMarkdownAtomic } from '../filesystem/atomic-write.js';
import {
  inspectManagementMarker,
  markdownBody,
} from '../filesystem/management-marker.js';
import { moveManagedFile } from '../filesystem/mover.js';
import {
  assertNoSymlinkEscape,
  joinManagedPath,
} from '../filesystem/safe-path.js';
import { inspectUnsupportedSidecarTarget } from '../filesystem/unsupported-sidecar-target.js';
import { trashManagedFile } from '../filesystem/trash.js';
import type { RootCensus, CensusResource } from '../notion/census.js';
import type { BlockNode } from '../notion/blocks.js';
import type {
  StateStore,
  StoredResource,
  SyncMode,
  SyncRunCounts,
  AssetState,
  WarningState,
} from '../storage/state-store.js';
import { createFrontmatter } from '../transform/frontmatter.js';
import type { UnsupportedSidecar } from '../transform/unsupported.js';
import type { createLogger } from '../logging/index.js';
import { createDataSourceIndex } from '../transform/data-source-index.js';
import {
  convertDataSourceProperty,
  resolveRelationProperty,
} from '../transform/data-source-properties.js';
import { transformEnhancedMarkdown } from '../transform/enhanced-markdown.js';
import {
  buildIdToPathMap,
  resolveInternalLinks,
} from '../transform/obsidian-links.js';
import { planMissingResources } from './deletion-guard.js';
import { allocateOutputPaths } from './output-path-allocator.js';
import { validateSyncPlan, type SyncPlanAction } from './plan-validator.js';
import { reconcileResource, type ResourceFingerprint } from './reconciler.js';
import {
  planUnsupportedSidecars,
  type PlannedUnsupportedSidecar,
} from './unsupported-sidecar-plan.js';

const API_VERSION = '2026-03-11';
const TOOL_VERSION = '0.1.0';
const TRANSFORM_VERSION = '1';

interface LockBoundary {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

interface RetrievedContent {
  markdown: string;
  warnings: Array<{ type: string; message: string }>;
  sidecars: UnsupportedSidecar[];
}

export interface OrchestratorDependencies {
  store: StateStore;
  lock: LockBoundary;
  census(rootId: string): Promise<RootCensus>;
  retrieveContent(pageId: string): Promise<RetrievedContent>;
  fetchDataSourceRows?(
    dataSourceId: string,
  ): Promise<Array<Record<string, unknown>>>;
  now(): string;
  runId(): string;
  recover?(dryRun: boolean): Promise<void>;
  retrieveBlocks?(pageId: string): Promise<BlockNode[]>;
  downloadAsset?(request: {
    url: URL;
    destination: string;
    maximumBytes: number;
  }): Promise<DownloadResult>;
  logger?: ReturnType<typeof createLogger>;
}

export interface SyncOptions {
  dryRun?: boolean;
  full?: boolean;
  pageId?: string;
  rootId?: string;
  strict?: boolean;
  allowLargeTrash?: boolean;
  verbose?: boolean;
}

export type OrchestratedAction =
  | {
      type: 'CREATE' | 'UPDATE' | 'MOVE' | 'TRASH' | 'UNCHANGED' | 'WARNING';
      notionId: string;
      stableKey?: never;
      path?: string;
      message?: string;
    }
  | {
      type: 'ASSET_DEFERRED';
      stableKey: string;
      notionId?: never;
      path: string;
      message?: never;
    };

export interface SyncResult {
  runId: string;
  dryRun: boolean;
  partial: boolean;
  partialFailure: boolean;
  actions: OrchestratedAction[];
  counts: SyncRunCounts;
}

interface PlannedContent {
  resource: CensusResource;
  path: PlannedResourcePath;
  body: string;
  contentHash: string;
  structureHash: string;
  warnings: Array<{ type: string; message: string }>;
  fingerprint: ResourceFingerprint;
  stored: StoredResource | undefined;
  reconciliation: ReturnType<typeof reconcileResource>;
  properties?: Readonly<Record<string, unknown>>;
  dataSourceIndex: boolean;
  assets: AssetState[];
  assetStateUpdates: AssetState[];
  assetWarnings: WarningState[];
  plannedSidecars: PlannedUnsupportedSidecar[];
  assetPlan?: PlannedPageAssets;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function configHash(config: AppConfig): string {
  return hash(
    JSON.stringify({
      roots: config.notion.roots,
      obsidian: config.obsidian,
      sync: config.sync,
    }),
  );
}

function mode(options: SyncOptions): SyncMode {
  if (options.pageId) return 'page';
  if (options.rootId) return 'root';
  if (options.full) return 'full';
  return 'incremental';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new InfraError('storage', `Path inspection failed: ${message}`, {
      cause: error,
    });
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function zeroCounts(): SyncRunCounts {
  return { create: 0, update: 0, move: 0, trash: 0, unchanged: 0, error: 0 };
}

function assetFingerprint(assets: readonly AssetState[]): string {
  return assets
    .filter(({ cacheStatus }) => cacheStatus !== 'unverified')
    .map(({ stableKey, contentHash, etag, lastModified, size }) =>
      JSON.stringify({ stableKey, contentHash, etag, lastModified, size }),
    )
    .sort()
    .join('|');
}

function selectedAssetPlan(
  item: PlannedContent,
): PlannedPageAssets | undefined {
  const plan = item.assetPlan;
  if (!plan) return undefined;
  const { type, reasons } = item.reconciliation;
  if (
    type !== 'CREATE' &&
    type !== 'UPDATE' &&
    !(type === 'MOVE' && reasons.length > 1)
  ) {
    return undefined;
  }
  const force = reasons.some((reason) =>
    ['content', 'last_edited_time', 'asset'].includes(reason),
  );
  return {
    ...plan,
    downloads: plan.downloads.filter(({ cached }) => force || !cached),
  };
}

function storedFingerprint(
  stored: StoredResource | undefined,
  currentConfigHash: string,
  previousConfigHash: string | undefined,
  assets: readonly AssetState[],
): Parameters<typeof reconcileResource>[0] {
  if (!stored) return undefined;
  return {
    ...stored,
    configHash: previousConfigHash ?? currentConfigHash,
    transformVersion: TRANSFORM_VERSION,
    apiVersion: API_VERSION,
    assetFingerprint: assetFingerprint(assets),
  };
}

export async function runSyncOrchestrator(
  config: AppConfig,
  options: SyncOptions,
  dependencies: OrchestratorDependencies,
): Promise<SyncResult> {
  const dryRun = options.dryRun ?? false;
  const runId = dependencies.runId();
  const startedAt = dependencies.now();
  const currentConfigHash = configHash(config);
  const previousRun = dependencies.store.getLatestRun();
  const counts = zeroCounts();
  const actions: OrchestratedAction[] = [];
  let beganRun = false;
  await dependencies.lock.acquire();
  try {
    dependencies.logger?.debug('sync started', {
      run_id: runId,
      action: dryRun ? 'plan' : 'apply',
    });
    if (dependencies.store.listUnfinishedRuns().length > 0) {
      await dependencies.recover?.(dryRun);
    }
    if (!dryRun) {
      dependencies.store.beginRun({
        runId,
        startedAt,
        mode: mode(options),
        configHash: currentConfigHash,
        apiVersion: API_VERSION,
        toolVersion: TOOL_VERSION,
        transformVersion: TRANSFORM_VERSION,
      });
      beganRun = true;
    }

    const validationRoots = config.notion.roots;
    const actionRoots = config.notion.roots.filter(
      (root) => !options.rootId || root.pageId === options.rootId,
    );
    const censuses: RootCensus[] = [];
    const pathCensuses: RootCensus[] = [];
    const dataSourceRows = new Map<
      string,
      Array<{ notionId: string; properties: Record<string, unknown> }>
    >();
    const rowProperties = new Map<string, Record<string, unknown>>();
    const seenDataSources = new Set<string>();
    for (const root of validationRoots) {
      const result = await dependencies.census(root.pageId);
      const pathResources = result.resources.map((resource) =>
        resource.notionId === root.pageId
          ? { ...resource, title: root.localName }
          : resource,
      );
      const pathExpanded = [...pathResources];
      for (const resource of pathResources) {
        if (
          resource.objectType !== 'database' ||
          !resource.dataSourceId ||
          seenDataSources.has(resource.dataSourceId) ||
          !dependencies.fetchDataSourceRows
        )
          continue;
        seenDataSources.add(resource.dataSourceId);
        const rows = await dependencies.fetchDataSourceRows(
          resource.dataSourceId,
        );
        const indexedRows: Array<{
          notionId: string;
          properties: Record<string, unknown>;
        }> = [];
        for (const row of rows) {
          const notionId = typeof row.id === 'string' ? row.id : undefined;
          const properties =
            row.properties && typeof row.properties === 'object'
              ? (row.properties as Record<string, unknown>)
              : undefined;
          if (!notionId || !properties) continue;
          const titleProperty = Object.values(properties).find(
            (property) =>
              property !== null &&
              typeof property === 'object' &&
              (property as Record<string, unknown>).type === 'title',
          );
          const convertedTitle = convertDataSourceProperty(titleProperty);
          const title =
            typeof convertedTitle === 'string' && convertedTitle.length > 0
              ? convertedTitle
              : notionId;
          const expandedRow: CensusResource = {
            notionId,
            objectType: 'page',
            title,
            parentId: resource.notionId,
            parentType: 'database',
            rootId: resource.rootId,
            lastEditedTime:
              typeof row.last_edited_time === 'string'
                ? row.last_edited_time
                : '',
            inTrash: row.in_trash === true || row.archived === true,
            url: typeof row.url === 'string' ? row.url : '',
          };
          pathExpanded.push(expandedRow);
          rowProperties.set(notionId, properties);
          indexedRows.push({ notionId, properties });
        }
        dataSourceRows.set(resource.notionId, indexedRows);
      }
      const expanded = pathExpanded.filter(
        (resource) => !options.pageId || resource.notionId === options.pageId,
      );
      if (actionRoots.some(({ pageId }) => pageId === root.pageId)) {
        censuses.push({ ...result, resources: expanded });
      }
      pathCensuses.push({ ...result, resources: pathExpanded });
    }

    const rootIdByNotionId = new Map<string, string>();
    for (const census of pathCensuses) {
      for (const resource of census.resources) {
        const firstRootId = rootIdByNotionId.get(resource.notionId);
        if (firstRootId && firstRootId !== census.rootId) {
          throw new DomainError(
            'validation',
            `Sync cannot continue because Notion page ID ${resource.notionId} belongs to configured roots ${firstRootId} and ${census.rootId}. Remove overlapping roots from notion.roots so each page belongs to one root`,
          );
        }
        rootIdByNotionId.set(resource.notionId, census.rootId);
      }
    }
    const pathResourceById = new Map(
      pathCensuses.flatMap((census) =>
        census.resources.map((resource) => [resource.notionId, resource]),
      ),
    );

    const existing = dependencies.store.listResources();
    const existingAssets = dependencies.store.listAssets();
    const existingById = new Map(
      existing.map((resource) => [resource.notionId, resource]),
    );
    const allPaths: PlannedResourcePath[] = [];
    for (const census of pathCensuses) {
      const previousResolvedFilenames = new Map(
        existing
          .filter((resource) => resource.rootId === census.rootId)
          .map((resource) => [resource.notionId, resource.resolvedFilename]),
      );
      const paths = planResourcePaths(census.resources, {
        previousResolvedFilenames,
      });
      const resourcesById = new Map(
        census.resources.map((resource) => [resource.notionId, resource]),
      );
      allPaths.push(
        ...paths.map((path) => {
          const resource = resourcesById.get(path.notionId);
          if (resource?.objectType !== 'database' || !resource.dataSourceId)
            return path;
          return {
            ...path,
            expectedPath: `${path.expectedPath.replace(/\.md$/iu, '')}/_index.md`,
          };
        }),
      );
    }
    const outputPathAllocation = await allocateOutputPaths({
      paths: allPaths,
      existingById,
      managedRoot: config.obsidian.managedPath,
      exists,
    });
    const pathById = new Map(
      outputPathAllocation.paths.map((path) => [path.notionId, path]),
    );
    const idToPath = buildIdToPathMap(outputPathAllocation.paths);
    const collisionWarningsById = new Map<string, string[]>();
    for (const warning of outputPathAllocation.warnings) {
      collisionWarningsById.set(warning.notionId, [
        ...(collisionWarningsById.get(warning.notionId) ?? []),
        warning.message,
      ]);
    }
    const planned: PlannedContent[] = [];
    let warningCount = 0;
    for (const census of censuses) {
      for (const resource of census.resources) {
        const path = pathById.get(resource.notionId);
        if (!path) continue;
        const indexedRows = dataSourceRows.get(resource.notionId);
        const retrieved = indexedRows
          ? { markdown: '', warnings: [], sidecars: [] }
          : await dependencies.retrieveContent(resource.notionId);
        const sourceBody = indexedRows
          ? createDataSourceIndex({
              name: resource.title,
              notionUrl: resource.url,
              dataSourceId: resource.dataSourceId ?? resource.notionId,
              schema: Object.entries(indexedRows[0]?.properties ?? {}).map(
                ([name, property]) => {
                  const propertyType =
                    property !== null && typeof property === 'object'
                      ? (property as Record<string, unknown>).type
                      : undefined;
                  return {
                    name,
                    type:
                      typeof propertyType === 'string'
                        ? propertyType
                        : 'unknown',
                  };
                },
              ),
              rows: indexedRows.flatMap(({ notionId }) => {
                const rowPath = pathById.get(notionId);
                const rowResource = pathResourceById.get(notionId);
                return rowPath && rowResource
                  ? [{ title: rowResource.title, path: rowPath.expectedPath }]
                  : [];
              }),
              syncedAt: startedAt,
              notionId: resource.notionId,
            })
          : await transformEnhancedMarkdown(retrieved.markdown);
        let body = sourceBody;
        let plannedAssets: AssetState[] = [];
        const assetStateUpdates: AssetState[] = [];
        let assetWarnings: WarningState[] = [];
        let plannedAssetPlan: PlannedPageAssets | undefined;
        if (
          !indexedRows &&
          dependencies.retrieveBlocks &&
          dependencies.downloadAsset
        ) {
          const blocks = await dependencies.retrieveBlocks(resource.notionId);
          const assetPlan = await planPageAssets(
            {
              pageId: resource.notionId,
              markdown: body,
              pagePath: path.expectedPath,
              blocks,
              managedRoot: config.obsidian.managedPath,
              runId,
              now: startedAt,
              maximumBytes: config.sync.maximum_asset_size_mb * 1024 * 1024,
              notionAssetAllowedContentTypes:
                config.sync.notion_asset_allowed_content_types,
              notionAssetAllowedExtensions:
                config.sync.notion_asset_allowed_extensions,
              externalAssetAllowedContentTypes:
                config.sync.external_asset_allowed_content_types,
              externalAssetAllowedExtensions:
                config.sync.external_asset_allowed_extensions,
              downloadExternalAssets: config.sync.download_external_assets,
            },
            {
              getAsset: (stableKey) => dependencies.store.getAsset(stableKey),
            },
          );
          body = assetPlan.markdown;
          plannedAssets = assetPlan.assets;
          assetWarnings = assetPlan.warnings;
          plannedAssetPlan = assetPlan;
        }
        if (!indexedRows) body = await resolveInternalLinks(body, idToPath);
        const contentHash = hash(body);
        const structureHash = hash(
          JSON.stringify({
            rootId: resource.rootId,
            parentId: resource.parentId,
            expectedPath: path.expectedPath,
          }),
        );
        const fingerprint: ResourceFingerprint = {
          notionId: resource.notionId,
          title: resource.title,
          ...(resource.parentId ? { parentId: resource.parentId } : {}),
          rootId: resource.rootId,
          lastEditedTime: resource.lastEditedTime,
          expectedPath: path.expectedPath,
          resolvedFilename: path.resolvedFilename,
          contentHash,
          structureHash,
          configHash: currentConfigHash,
          transformVersion: TRANSFORM_VERSION,
          apiVersion: API_VERSION,
          assetFingerprint: assetFingerprint(plannedAssets),
        };
        const stored = existingById.get(resource.notionId);
        const rawProperties = rowProperties.get(resource.notionId);
        const properties = rawProperties
          ? Object.fromEntries(
              Object.entries(rawProperties).map(([name, property]) => [
                name,
                property !== null &&
                typeof property === 'object' &&
                (property as Record<string, unknown>).type === 'relation'
                  ? resolveRelationProperty(property, idToPath)
                  : convertDataSourceProperty(property),
              ]),
            )
          : undefined;
        let reconciliation = reconcileResource(
          storedFingerprint(
            stored,
            currentConfigHash,
            previousRun?.configHash,
            existingAssets.filter(({ pageId }) => pageId === resource.notionId),
          ),
          fingerprint,
        );
        if (options.full && stored && reconciliation.type === 'UNCHANGED') {
          reconciliation = { ...reconciliation, type: 'UPDATE' };
        }
        if (stored && !indexedRows && reconciliation.type === 'UNCHANGED') {
          const targetPath = joinManagedPath(
            config.obsidian.managedPath,
            path.expectedPath,
          );
          if (!(await exists(targetPath))) {
            reconciliation = { ...reconciliation, type: 'UPDATE' };
          } else {
            const localContent = await readFile(targetPath, 'utf8');
            const marker = inspectManagementMarker({
              managedRoot: config.obsidian.managedPath,
              filePath: targetPath,
              content: localContent,
              stored,
            });
            const localBody = markdownBody(localContent);
            const localHash =
              localBody === undefined ? undefined : hash(localBody);
            if (!marker.managed || localHash !== stored.contentHash) {
              reconciliation = { ...reconciliation, type: 'UPDATE' };
            }
          }
        }
        const warnings = [
          ...retrieved.warnings,
          ...(collisionWarningsById.get(resource.notionId) ?? []).map(
            (message) => ({ type: 'move_collision', message }),
          ),
        ];
        warningCount += warnings.length + assetWarnings.length;
        const plannedSidecars = planUnsupportedSidecars({
          managedRoot: config.obsidian.managedPath,
          pageId: resource.notionId,
          sidecars: retrieved.sidecars,
        });
        const plannedItem: PlannedContent = {
          resource,
          path,
          body,
          contentHash,
          structureHash,
          warnings,
          fingerprint,
          stored,
          reconciliation,
          ...(properties ? { properties } : {}),
          dataSourceIndex: Boolean(indexedRows),
          assets: plannedAssets,
          assetStateUpdates,
          assetWarnings,
          plannedSidecars,
          ...(plannedAssetPlan ? { assetPlan: plannedAssetPlan } : {}),
        };
        planned.push(plannedItem);
        actions.push({
          type: reconciliation.type,
          notionId: resource.notionId,
          path: path.expectedPath,
        });
        for (const warning of assetWarnings) {
          actions.push({
            type: 'WARNING',
            notionId: resource.notionId,
            message: warning.message,
          });
        }
        if (dryRun) {
          const assetPlan = selectedAssetPlan(plannedItem);
          for (const download of assetPlan?.downloads ?? []) {
            await assertAssetPathSafe(
              config.obsidian.managedPath,
              download.target.absolutePath,
            );
            if (
              (await inspectAssetTargetForPlan(download.target)) === 'deferred'
            ) {
              actions.push({
                type: 'ASSET_DEFERRED',
                stableKey: download.target.stableKey,
                path: download.target.localPath,
              });
            }
          }
        }
      }
      actions.push(
        ...census.warnings.map((warning) => ({
          type: 'WARNING' as const,
          notionId: warning.resourceId,
          message: warning.message,
        })),
      );
      warningCount += census.warnings.length;
    }

    const globallySeenIds = new Set(
      censuses.flatMap(({ resources }) =>
        resources.map(({ notionId }) => notionId),
      ),
    );
    const configuredRootIds = new Set(
      config.notion.roots.map(({ pageId }) => pageId),
    );
    const removedRootCensuses: RootCensus[] = options.rootId
      ? []
      : dependencies.store
          .listRoots()
          .filter(
            ({ rootPageId, lastSuccessfulCensus }) =>
              !configuredRootIds.has(rootPageId) &&
              lastSuccessfulCensus !== undefined,
          )
          .map(({ rootPageId }) => ({
            rootId: rootPageId,
            status: 'complete',
            deletionAllowed: true,
            resources: [],
            warnings: [],
          }));
    const trashPlans = [
      ...censuses.map((census) => ({
        census,
        plan: planMissingResources({
          root: census,
          existing,
          mode: mode(options),
          graceRuns: config.sync.deletion_grace_runs,
          globallySeenIds,
        }),
      })),
      ...removedRootCensuses.map((census) => ({
        census,
        plan: planMissingResources({
          root: census,
          existing,
          mode: mode(options),
          graceRuns: config.sync.deletion_grace_runs,
          globallySeenIds,
          missingReason: 'root_removed_from_config',
        }),
      })),
    ];
    for (const { plan } of trashPlans) {
      for (const candidate of plan.trash) {
        const stored = existingById.get(candidate.notionId);
        if (stored?.localPath) {
          actions.push({
            type: 'TRASH',
            notionId: candidate.notionId,
            path: stored.localPath,
          });
        }
      }
    }

    const validationActions: SyncPlanAction[] = [];
    for (const item of planned) {
      const targetPath = joinManagedPath(
        config.obsidian.managedPath,
        item.path.expectedPath,
      );
      if (
        item.reconciliation.type === 'CREATE' ||
        item.reconciliation.type === 'UPDATE'
      ) {
        let targetState: 'absent' | 'managed' | 'unmanaged' = 'absent';
        if (await exists(targetPath)) {
          const content = await readFile(targetPath, 'utf8');
          targetState = inspectManagementMarker({
            managedRoot: config.obsidian.managedPath,
            filePath: targetPath,
            content,
            stored: item.stored,
          }).managed
            ? 'managed'
            : 'unmanaged';
        }
        validationActions.push({
          type: 'WRITE',
          notionId: item.resource.notionId,
          targetPath,
          targetState,
        });
      } else if (
        item.reconciliation.type === 'MOVE' &&
        item.stored?.localPath
      ) {
        validationActions.push({
          type: 'MOVE',
          notionId: item.resource.notionId,
          sourcePath: joinManagedPath(
            config.obsidian.managedPath,
            item.stored.localPath,
          ),
          targetPath,
          managed: true,
        });
      }
      for (const sidecar of item.plannedSidecars) {
        await assertNoSymlinkEscape(
          { isSymbolicLink },
          config.obsidian.managedPath,
          sidecar.targetPath,
        );
        const inspection = await inspectUnsupportedSidecarTarget({
          managedRoot: config.obsidian.managedPath,
          targetPath: sidecar.targetPath,
          expectedPageId: sidecar.pageId,
          expectedSidecarId: sidecar.sidecarId,
          storedPage: item.stored,
        });
        if (inspection.kind === 'not-regular') {
          throw new DomainError(
            'safety',
            'Unsupported sidecar target is not a regular file; inspect or remove the conflicting path before syncing',
          );
        }
        if (inspection.kind === 'unreadable') {
          throw new InfraError(
            'storage',
            'Unsupported sidecar target cannot be read; inspect its permissions before syncing',
          );
        }
        validationActions.push({
          type: 'WRITE',
          notionId: sidecar.actionId,
          targetPath: sidecar.targetPath,
          targetState:
            inspection.kind === 'owned'
              ? 'managed'
              : inspection.kind === 'unmanaged'
                ? 'unmanaged'
                : 'absent',
        });
      }
    }
    for (const { plan } of trashPlans) {
      for (const candidate of plan.trash) {
        const stored = existingById.get(candidate.notionId);
        if (stored?.localPath) {
          validationActions.push({
            type: 'TRASH',
            notionId: candidate.notionId,
            sourcePath: joinManagedPath(
              config.obsidian.managedPath,
              stored.localPath,
            ),
            managed: true,
          });
        }
      }
    }
    await validateSyncPlan({
      managedRoot: config.obsidian.managedPath,
      vaultRoot: config.obsidian.vaultPath,
      censusComplete: censuses.every(
        ({ status, deletionAllowed }) =>
          status === 'complete' && deletionAllowed,
      ),
      managedResourceCount: existing.length,
      allowLargeTrash: options.allowLargeTrash ?? false,
      maximumTrashRatio: config.sync.maximum_trash_ratio,
      maximumTrashCount: config.sync.maximum_trash_count,
      actions: validationActions,
    });

    if (!dryRun) {
      for (const root of actionRoots) {
        const census = censuses.find(({ rootId }) => rootId === root.pageId);
        if (!census) continue;
        dependencies.store.upsertRoot({
          rootPageId: root.pageId,
          localName: root.localName,
          status: census.status,
          ...(census.status === 'complete'
            ? { lastSuccessfulCensus: startedAt }
            : {}),
          lastSeenRunId: runId,
        });
      }
      for (const item of planned) {
        const type = item.reconciliation.type;
        if (type === 'MOVE' && item.stored?.localPath) {
          await moveManagedFile({
            managedRoot: config.obsidian.managedPath,
            sourcePath: item.stored.localPath,
            targetPath: item.path.expectedPath,
            stored: item.stored,
          });
        }
        const absolutePath = joinManagedPath(
          config.obsidian.managedPath,
          item.path.expectedPath,
        );
        if (
          type === 'CREATE' ||
          type === 'UPDATE' ||
          (type === 'MOVE' && item.reconciliation.reasons.length > 1)
        ) {
          const assetPlan = selectedAssetPlan(item);
          if (assetPlan && dependencies.downloadAsset) {
            const processed = await applyPlannedPageAssets(
              {
                managedRoot: config.obsidian.managedPath,
                runId,
                now: startedAt,
                maximumBytes: config.sync.maximum_asset_size_mb * 1024 * 1024,
              },
              assetPlan,
              {
                download: (request) => dependencies.downloadAsset!(request),
              },
            );
            item.body = await resolveInternalLinks(
              processed.markdown,
              idToPath,
            );
            item.assets = processed.assets;
            item.assetStateUpdates = processed.assetStateUpdates;
            item.assetWarnings = [...item.assetWarnings, ...processed.warnings];
            warningCount += processed.warnings.length;
          }
          item.contentHash = hash(item.body);
          const frontmatter = item.dataSourceIndex
            ? ''
            : createFrontmatter({
                notionId: item.resource.notionId,
                notionUrl: item.resource.url,
                notionRootId: item.resource.rootId,
                notionParentId: item.resource.parentId ?? null,
                notionObjectType: item.resource.objectType,
                notionLastEditedTime: item.resource.lastEditedTime,
                syncedAt: startedAt,
                title: item.resource.title,
                contentHash: item.contentHash,
                ...(item.properties ? { properties: item.properties } : {}),
              });
          await writeMarkdownAtomic(
            absolutePath,
            `${frontmatter}${item.body}`,
            type === 'CREATE' || type === 'UPDATE'
              ? {
                  managedRoot: config.obsidian.managedPath,
                  ownership: {
                    kind: 'markdown-marker',
                    stored: item.stored,
                  } as const,
                }
              : { managedRoot: config.obsidian.managedPath },
          );
        }
        for (const sidecar of item.plannedSidecars) {
          await writeMarkdownAtomic(sidecar.targetPath, sidecar.content, {
            managedRoot: config.obsidian.managedPath,
            ownership: {
              kind: 'unsupported-sidecar',
              expectedPageId: sidecar.pageId,
              expectedSidecarId: sidecar.sidecarId,
              storedPage: item.stored,
            },
          });
        }
        if (type !== 'UNCHANGED') {
          dependencies.store.transaction(() => {
            dependencies.store.upsertResource({
              notionId: item.resource.notionId,
              objectType: item.resource.objectType,
              rootId: item.resource.rootId,
              ...(item.resource.parentId
                ? { parentId: item.resource.parentId }
                : {}),
              title: item.resource.title,
              localPath: item.path.expectedPath,
              expectedPath: item.path.expectedPath,
              resolvedFilename: item.path.resolvedFilename,
              lastEditedTime: item.resource.lastEditedTime,
              lastSeenRunId: runId,
              inTrash: false,
              status: 'active',
              contentHash: item.contentHash,
              structureHash: item.structureHash,
              missingCount: 0,
              createdAt: item.stored?.createdAt ?? startedAt,
              updatedAt: startedAt,
            });
            // Plan 由来の asset（cached adoption）と Apply で確定した最終状態を
            // stable key ごとに1件へまとめて upsert する。同じ key を2回書かない。
            // Apply の確定状態（assetStateUpdates）を後に set して Plan 時点の状態
            // より優先する。並べ替えるとこの優先関係が壊れるため順序を保つこと。
            const assetsByStableKey = new Map<string, AssetState>();
            for (const asset of item.assets) {
              assetsByStableKey.set(asset.stableKey, asset);
            }
            for (const asset of item.assetStateUpdates) {
              assetsByStableKey.set(asset.stableKey, asset);
            }
            for (const asset of assetsByStableKey.values()) {
              dependencies.store.upsertAsset(asset);
            }
          });
        }
        for (const warning of [
          ...item.warnings.map((value) => ({
            runId,
            resourceId: item.resource.notionId,
            warningType: value.type,
            message: value.message,
            createdAt: startedAt,
          })),
          ...item.assetWarnings,
        ]) {
          dependencies.store.insertWarning(warning);
        }
        counts[type.toLowerCase() as keyof SyncRunCounts] += 1;
        dependencies.logger?.debug('sync action', {
          run_id: runId,
          resource_id: item.resource.notionId,
          action: type,
          local_path: item.path.expectedPath,
        });
      }
      for (const census of censuses) {
        for (const warning of census.warnings) {
          dependencies.store.insertWarning({
            runId,
            ...(dependencies.store.getResource(warning.resourceId)
              ? { resourceId: warning.resourceId }
              : {}),
            warningType: warning.type,
            message: warning.message,
            createdAt: startedAt,
          });
          dependencies.logger?.warn(warning.message, {
            run_id: runId,
            resource_id: warning.resourceId,
            warning_type: warning.type,
          });
        }
      }
      for (const { plan } of trashPlans) {
        for (const update of plan.updates) {
          dependencies.store.updateResourceMissingState(update.notionId, {
            missingCount: update.missingCount,
            status: update.missingCount > 0 ? 'missing' : 'active',
          });
        }
        for (const candidate of plan.trash) {
          const stored = dependencies.store.getResource(candidate.notionId);
          if (!stored?.localPath) continue;
          await trashManagedFile({
            managedRoot: config.obsidian.managedPath,
            sourcePath: stored.localPath,
            notionId: stored.notionId,
            stored,
            reason: candidate.reason,
            date: startedAt.slice(0, 10),
            onTrashed: ({ trashPath, reason }) =>
              dependencies.store.upsertResource({
                ...stored,
                localPath: trashPath,
                inTrash: true,
                status: 'tombstoned',
                tombstonedAt: startedAt,
                trashReason: reason,
                updatedAt: startedAt,
              }),
          });
          counts.trash += 1;
        }
      }
      dependencies.store.finishRun({
        runId,
        finishedAt: dependencies.now(),
        success: true,
        partial: censuses.some(({ status }) => status === 'partial'),
        counts,
      });
    } else {
      for (const action of actions) {
        const key = action.type.toLowerCase();
        if (key in counts) counts[key as keyof SyncRunCounts] += 1;
      }
    }
    return {
      runId,
      dryRun,
      partial: censuses.some(({ status }) => status === 'partial'),
      partialFailure: Boolean(options.strict && warningCount > 0),
      actions,
      counts,
    };
  } catch (error) {
    if (beganRun) {
      dependencies.store.finishRun({
        runId,
        finishedAt: dependencies.now(),
        success: false,
        partial: true,
        counts: { ...counts, error: counts.error + 1 },
      });
    }
    throw error;
  } finally {
    await dependencies.lock.release();
  }
}
