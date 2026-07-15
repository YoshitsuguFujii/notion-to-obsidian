import type { PlannedResourcePath } from '../domain/path-plan.js';
import type { RootCensus } from '../notion/census.js';

export type CensusPlanAction =
  | {
      type: 'CREATE' | 'UPDATE' | 'UNCHANGED';
      notionId: string;
      expectedPath: string;
    }
  | { type: 'WARNING'; notionId: string; message: string };

export interface CensusPlan {
  rootId: string;
  deletionAllowed: boolean;
  actions: CensusPlanAction[];
}

export function buildCensusPlan(
  census: RootCensus,
  paths: readonly PlannedResourcePath[],
  existing: ReadonlyMap<string, { expectedPath: string }> = new Map(),
): CensusPlan {
  const actions: CensusPlanAction[] = paths.map((path) => {
    const stored = existing.get(path.notionId);
    const type = !stored
      ? 'CREATE'
      : stored.expectedPath === path.expectedPath
        ? 'UNCHANGED'
        : 'UPDATE';
    return { type, notionId: path.notionId, expectedPath: path.expectedPath };
  });
  actions.push(
    ...census.warnings.map((warning) => ({
      type: 'WARNING' as const,
      notionId: warning.resourceId,
      message: warning.message,
    })),
  );
  return {
    rootId: census.rootId,
    deletionAllowed: census.status === 'complete' && census.deletionAllowed,
    actions,
  };
}
