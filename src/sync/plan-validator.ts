import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { parse, relative, resolve } from 'node:path';
import { DomainError } from '../errors.js';
import {
  assertNoSymlinkEscape,
  joinManagedPath,
} from '../filesystem/safe-path.js';
import { assertTrashWithinLimits } from './deletion-guard.js';
import { outputPathCollisionKey } from './output-path-collision-key.js';

export type SyncPlanAction =
  | {
      type: 'WRITE';
      notionId: string;
      targetPath: string;
      targetState?: 'absent' | 'managed' | 'unmanaged';
    }
  | {
      type: 'MOVE';
      notionId: string;
      sourcePath: string;
      targetPath: string;
      managed: boolean;
    }
  | {
      type: 'TRASH';
      notionId: string;
      sourcePath: string;
      managed: boolean;
    };

export interface ValidatableSyncPlan {
  managedRoot: string;
  vaultRoot: string;
  censusComplete: boolean;
  managedResourceCount: number;
  allowLargeTrash: boolean;
  maximumTrashRatio?: number;
  maximumTrashCount?: number;
  actions: readonly SyncPlanAction[];
}

interface PathInspector {
  isSymbolicLink(path: string): Promise<boolean>;
}

function safetyError(message: string): DomainError {
  return new DomainError('safety', message);
}

function assertManagedRootIsSafe(managedRoot: string, vaultRoot: string): void {
  const root = resolve(managedRoot);
  if (
    root === parse(root).root ||
    root === resolve(homedir()) ||
    root === resolve(vaultRoot)
  ) {
    throw safetyError('Configured managed root is unsafe');
  }
}

function assertWithinRoot(managedRoot: string, path: string): void {
  joinManagedPath(managedRoot, relative(resolve(managedRoot), resolve(path)));
}

export async function validateSyncPlan(
  plan: ValidatableSyncPlan,
  inspector: PathInspector = {
    async isSymbolicLink(path) {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  },
): Promise<void> {
  assertManagedRootIsSafe(plan.managedRoot, plan.vaultRoot);
  const outputs = new Map<string, string>();
  let trashCount = 0;

  for (const action of plan.actions) {
    if (action.type === 'WRITE' && action.targetState === 'unmanaged') {
      throw safetyError('Write action would overwrite an unmanaged file');
    }
    const paths =
      action.type === 'WRITE'
        ? [action.targetPath]
        : action.type === 'MOVE'
          ? [action.sourcePath, action.targetPath]
          : [action.sourcePath];
    for (const path of paths) {
      assertWithinRoot(plan.managedRoot, path);
      await assertNoSymlinkEscape(inspector, plan.managedRoot, path);
    }

    if ('managed' in action && !action.managed) {
      throw safetyError('Destructive action targets an unmanaged file');
    }
    if (action.type === 'TRASH') {
      trashCount += 1;
      if (resolve(action.sourcePath) === resolve(plan.managedRoot)) {
        throw safetyError('Managed root itself cannot be removed');
      }
      if (!plan.censusComplete) {
        throw safetyError('Partial census cannot contain trash actions');
      }
    }
    if (action.type === 'WRITE' || action.type === 'MOVE') {
      const output = outputPathCollisionKey(resolve(action.targetPath));
      const assigned = outputs.get(output);
      if (assigned && assigned !== action.notionId) {
        throw safetyError('Multiple resources share the same output path');
      }
      outputs.set(output, action.notionId);
    }
  }

  assertTrashWithinLimits({
    trashCount,
    managedCount: plan.managedResourceCount,
    allowLargeTrash: plan.allowLargeTrash,
    ...(plan.maximumTrashRatio === undefined
      ? {}
      : { maximumTrashRatio: plan.maximumTrashRatio }),
    ...(plan.maximumTrashCount === undefined
      ? {}
      : { maximumTrashCount: plan.maximumTrashCount }),
  });
}
