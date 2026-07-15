import { DomainError } from '../errors.js';
import type { RootCensus } from '../notion/census.js';
import type { StoredResource, SyncMode } from '../storage/state-store.js';

export type TrashReason =
  | 'notion_in_trash'
  | 'moved_out_of_scope'
  | 'root_removed_from_config'
  | 'confirmed_not_found'
  | 'manual_reconcile';

interface MissingPlanOptions {
  root: RootCensus;
  existing: readonly StoredResource[];
  mode: SyncMode;
  graceRuns?: number;
  blockingFailure?:
    | 'root'
    | 'pagination'
    | 'search_incomplete'
    | 'permission'
    | 'rate_limited'
    | 'server';
  confirmedReasons?: ReadonlyMap<string, TrashReason>;
  globallySeenIds?: ReadonlySet<string>;
  missingReason?: TrashReason;
}

export interface MissingResourcePlan {
  updates: Array<{ notionId: string; missingCount: number }>;
  trash: Array<{ notionId: string; reason: TrashReason }>;
}

export function planMissingResources(
  options: MissingPlanOptions,
): MissingResourcePlan {
  if (
    options.blockingFailure !== undefined ||
    options.mode === 'page' ||
    options.root.status !== 'complete' ||
    !options.root.deletionAllowed
  ) {
    return { updates: [], trash: [] };
  }

  const seen = new Set(
    options.root.resources.map((resource) => resource.notionId),
  );
  const updates: MissingResourcePlan['updates'] = [];
  const trash: MissingResourcePlan['trash'] = [];
  const graceRuns = options.graceRuns ?? 2;
  const censusById = new Map(
    options.root.resources.map((resource) => [resource.notionId, resource]),
  );
  for (const resource of options.existing) {
    if (
      resource.rootId !== options.root.rootId ||
      resource.status === 'tombstoned'
    )
      continue;
    const confirmedReason =
      options.confirmedReasons?.get(resource.notionId) ??
      (censusById.get(resource.notionId)?.inTrash
        ? 'notion_in_trash'
        : undefined);
    if (confirmedReason && confirmedReason !== 'notion_in_trash') {
      trash.push({ notionId: resource.notionId, reason: confirmedReason });
      continue;
    }
    if (confirmedReason === 'notion_in_trash') {
      const missingCount = resource.missingCount + 1;
      updates.push({ notionId: resource.notionId, missingCount });
      if (missingCount >= graceRuns) {
        trash.push({ notionId: resource.notionId, reason: confirmedReason });
      }
      continue;
    }
    if (
      !seen.has(resource.notionId) &&
      options.globallySeenIds?.has(resource.notionId)
    )
      continue;
    if (seen.has(resource.notionId)) {
      if (resource.missingCount > 0) {
        updates.push({ notionId: resource.notionId, missingCount: 0 });
      }
      continue;
    }
    const missingCount = resource.missingCount + 1;
    updates.push({ notionId: resource.notionId, missingCount });
    if (missingCount >= graceRuns) {
      trash.push({
        notionId: resource.notionId,
        reason: options.missingReason ?? 'confirmed_not_found',
      });
    }
  }
  return { updates, trash };
}

interface TrashLimitOptions {
  trashCount: number;
  managedCount: number;
  maximumTrashRatio?: number;
  maximumTrashCount?: number;
  allowLargeTrash?: boolean;
}

export function assertTrashWithinLimits(options: TrashLimitOptions): void {
  if (options.allowLargeTrash) return;
  const ratio =
    options.managedCount === 0
      ? options.trashCount > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : options.trashCount / options.managedCount;
  if (
    options.trashCount > (options.maximumTrashCount ?? 50) ||
    ratio > (options.maximumTrashRatio ?? 0.2)
  ) {
    throw new DomainError('safety', 'Plan exceeds the trash safety limit');
  }
}
