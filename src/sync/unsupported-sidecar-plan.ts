import { DomainError } from '../errors.js';
import { unsupportedSidecarPath } from '../filesystem/unsupported-sidecar-target.js';
import type { UnsupportedSidecar } from '../transform/unsupported.js';
import { outputPathCollisionKey } from './output-path-collision-key.js';

export interface PlannedUnsupportedSidecar {
  pageId: string;
  sidecarId: string;
  actionId: string;
  targetPath: string;
  content: string;
}

interface PlanUnsupportedSidecarsOptions {
  managedRoot: string;
  pageId: string;
  sidecars: readonly UnsupportedSidecar[];
}

export function planUnsupportedSidecars(
  options: PlanUnsupportedSidecarsOptions,
): PlannedUnsupportedSidecar[] {
  const plannedByPath = new Map<string, PlannedUnsupportedSidecar>();
  for (const sidecar of options.sidecars) {
    const sidecarWithExplicitPayload = {
      ...sidecar,
      payload: sidecar.payload ?? null,
    };
    const targetPath = unsupportedSidecarPath(
      options.managedRoot,
      options.pageId,
      sidecar.id,
    );
    const planned = {
      pageId: options.pageId,
      sidecarId: sidecar.id,
      actionId: `sidecar:${options.pageId}:${sidecar.id}`,
      targetPath,
      content: `${JSON.stringify(sidecarWithExplicitPayload, null, 2)}\n`,
    };
    const collisionKey = outputPathCollisionKey(targetPath);
    const existing = plannedByPath.get(collisionKey);
    if (!existing) {
      plannedByPath.set(collisionKey, planned);
    } else if (existing.content !== planned.content) {
      throw new DomainError(
        'safety',
        'Multiple unsupported sidecars share an output path with different content',
      );
    }
  }
  return [...plannedByPath.values()];
}
