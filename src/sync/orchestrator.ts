import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { processPageAssets } from '../assets/processor.js';
import type { DownloadResult } from '../assets/http-downloader.js';
import {
  planResourcePaths,
  type PlannedResourcePath,
} from '../domain/path-plan.js';
import { writeMarkdownAtomic } from '../filesystem/atomic-write.js';
import {
  inspectManagementMarker,
  markdownBody,
} from '../filesystem/management-marker.js';
import { moveManagedFile } from '../filesystem/mover.js';
import {
  joinManagedPath,
  sanitizePathSegment,
} from '../filesystem/safe-path.js';
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
import { validateSyncPlan, type SyncPlanAction } from './plan-validator.js';
import { reconcileResource, type ResourceFingerprint } from './reconciler.js';

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

export interface OrchestratedAction {
  type: 'CREATE' | 'UPDATE' | 'MOVE' | 'TRASH' | 'UNCHANGED' | 'WARNING';
  notionId: string;
  path?: string;
  message?: string;
}

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
  sourceBody: string;
  contentHash: string;
  structureHash: string;
  warnings: Array<{ type: string; message: string }>;
  fingerprint: ResourceFingerprint;
  stored: StoredResource | undefined;
  reconciliation: ReturnType<typeof reconcileResource>;
  properties?: Readonly<Record<string, unknown>>;
  dataSourceIndex: boolean;
  assets: AssetState[];
  assetWarnings: WarningState[];
  sidecars: UnsupportedSidecar[];
  blocks?: BlockNode[];
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
    throw error;
  }
}

function zeroCounts(): SyncRunCounts {
  return { create: 0, update: 0, move: 0, trash: 0, unchanged: 0, error: 0 };
}

function assetFingerprint(assets: readonly AssetState[]): string {
  return assets
    .map(({ stableKey, contentHash, etag, lastModified, size }) =>
      JSON.stringify({ stableKey, contentHash, etag, lastModified, size }),
    )
    .sort()
    .join('|');
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

    const selectedRoots = config.notion.roots.filter(
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
    for (const root of selectedRoots) {
      const result = await dependencies.census(root.pageId);
      const pathResources = result.resources.map((resource) =>
        resource.notionId === root.pageId
          ? { ...resource, title: root.localName }
          : resource,
      );
      const resources = pathResources.filter(
        (resource) => !options.pageId || resource.notionId === options.pageId,
      );
      const expanded = [...resources];
      const pathExpanded = [...pathResources];
      for (const resource of resources) {
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
          expanded.push(expandedRow);
          pathExpanded.push(expandedRow);
          rowProperties.set(notionId, properties);
          indexedRows.push({ notionId, properties });
        }
        dataSourceRows.set(resource.notionId, indexedRows);
      }
      censuses.push({ ...result, resources: expanded });
      pathCensuses.push({ ...result, resources: pathExpanded });
    }

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
    const pathById = new Map(allPaths.map((path) => [path.notionId, path]));
    const idToPath = buildIdToPathMap(allPaths);
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
                const rowResource = census.resources.find(
                  (candidate) => candidate.notionId === notionId,
                );
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
        let assetWarnings: WarningState[] = [];
        let blocks: BlockNode[] | undefined;
        if (
          !indexedRows &&
          dependencies.retrieveBlocks &&
          dependencies.downloadAsset
        ) {
          blocks = await dependencies.retrieveBlocks(resource.notionId);
          const assetPlan = await processPageAssets(
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
              apply: false,
            },
            {
              getAsset: (stableKey) => dependencies.store.getAsset(stableKey),
              download: (request) => dependencies.downloadAsset!(request),
            },
          );
          body = assetPlan.markdown;
          plannedAssets = assetPlan.assets;
          assetWarnings = assetPlan.warnings;
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
        warningCount += retrieved.warnings.length;
        planned.push({
          resource,
          path,
          body,
          sourceBody,
          contentHash,
          structureHash,
          warnings: retrieved.warnings,
          fingerprint,
          stored,
          reconciliation,
          ...(properties ? { properties } : {}),
          dataSourceIndex: Boolean(indexedRows),
          assets: plannedAssets,
          assetWarnings,
          sidecars: retrieved.sidecars,
          ...(blocks ? { blocks } : {}),
        });
        actions.push({
          type: reconciliation.type,
          notionId: resource.notionId,
          path: path.expectedPath,
        });
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
      for (const root of selectedRoots) {
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
          const moveResult = await moveManagedFile({
            managedRoot: config.obsidian.managedPath,
            sourcePath: item.stored.localPath,
            targetPath: item.path.expectedPath,
            notionId: item.resource.notionId,
            stored: item.stored,
          });
          if (moveResult.targetPath !== item.path.expectedPath) {
            const extension = posix.extname(moveResult.targetPath);
            item.path = {
              ...item.path,
              expectedPath: moveResult.targetPath,
              resolvedFilename: posix.basename(
                moveResult.targetPath,
                extension,
              ),
            };
            item.structureHash = hash(
              JSON.stringify({
                rootId: item.resource.rootId,
                parentId: item.resource.parentId,
                expectedPath: item.path.expectedPath,
              }),
            );
          }
          item.warnings.push(
            ...moveResult.warnings.map((message) => ({
              type: 'move_collision',
              message,
            })),
          );
          warningCount += moveResult.warnings.length;
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
          if (item.blocks && dependencies.downloadAsset) {
            const processed = await processPageAssets(
              {
                pageId: item.resource.notionId,
                markdown: item.sourceBody,
                pagePath: item.path.expectedPath,
                blocks: item.blocks,
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
                apply: true,
                force: item.reconciliation.reasons.some((reason) =>
                  ['content', 'last_edited_time', 'asset'].includes(reason),
                ),
              },
              {
                getAsset: (stableKey) => dependencies.store.getAsset(stableKey),
                download: (request) => dependencies.downloadAsset!(request),
              },
            );
            item.body = await resolveInternalLinks(
              processed.markdown,
              idToPath,
            );
            item.assets = processed.assets;
            item.assetWarnings = processed.warnings;
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
            {
              managedRoot: config.obsidian.managedPath,
            },
          );
        }
        for (const sidecar of item.sidecars) {
          const sidecarPath = joinManagedPath(
            config.obsidian.managedPath,
            '_unsupported',
            sanitizePathSegment(item.resource.notionId, item.resource.notionId),
            `${sanitizePathSegment(sidecar.id, sidecar.id)}.json`,
          );
          await writeMarkdownAtomic(
            sidecarPath,
            `${JSON.stringify(sidecar, null, 2)}\n`,
            { managedRoot: config.obsidian.managedPath },
          );
        }
        if (type !== 'UNCHANGED') {
          dependencies.store.transaction(() =>
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
            }),
          );
          for (const asset of item.assets) {
            dependencies.store.upsertAsset(asset);
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
