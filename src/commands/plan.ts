import { runSyncCommand, type SyncCommandOptions } from './sync.js';

export function runPlanCommand(options: SyncCommandOptions) {
  return runSyncCommand({ ...options, dryRun: true });
}
