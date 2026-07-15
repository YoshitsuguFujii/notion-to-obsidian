export type ReconcileReason =
  | 'notion_id'
  | 'last_edited_time'
  | 'local_path'
  | 'content'
  | 'structure'
  | 'config'
  | 'transform_version'
  | 'api_version'
  | 'asset'
  | 'title'
  | 'parent'
  | 'root'
  | 'collision';

export interface ResourceFingerprint {
  notionId: string;
  title: string;
  parentId?: string;
  rootId: string;
  lastEditedTime: string;
  expectedPath: string;
  resolvedFilename: string;
  contentHash?: string;
  structureHash?: string;
  configHash: string;
  transformVersion: string;
  apiVersion: string;
  assetFingerprint?: string;
}

export interface StoredResourceFingerprint extends ResourceFingerprint {
  localPath?: string;
}

export interface ResourceReconciliation {
  type: 'CREATE' | 'UPDATE' | 'MOVE' | 'UNCHANGED';
  notionId: string;
  reasons: ReconcileReason[];
}

const comparisons = [
  ['notionId', 'notion_id'],
  ['title', 'title'],
  ['parentId', 'parent'],
  ['rootId', 'root'],
  ['resolvedFilename', 'collision'],
  ['lastEditedTime', 'last_edited_time'],
  ['contentHash', 'content'],
  ['structureHash', 'structure'],
  ['configHash', 'config'],
  ['transformVersion', 'transform_version'],
  ['apiVersion', 'api_version'],
  ['assetFingerprint', 'asset'],
] as const satisfies ReadonlyArray<
  readonly [keyof ResourceFingerprint, ReconcileReason]
>;

export function reconcileResource(
  stored: StoredResourceFingerprint | undefined,
  current: ResourceFingerprint,
): ResourceReconciliation {
  if (!stored) {
    return { type: 'CREATE', notionId: current.notionId, reasons: [] };
  }
  const reasons: ReconcileReason[] = comparisons
    .filter(([key]) => stored[key] !== current[key])
    .map(([, reason]) => reason);
  if (stored.localPath !== current.expectedPath) {
    reasons.push('local_path');
    return { type: 'MOVE', notionId: current.notionId, reasons };
  }
  return {
    type: reasons.length > 0 ? 'UPDATE' : 'UNCHANGED',
    notionId: current.notionId,
    reasons,
  };
}
