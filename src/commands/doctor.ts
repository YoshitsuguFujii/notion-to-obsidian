import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../config/index.js';
import { NotionSdkClient } from '../notion/client.js';
import type { NotionClient } from '../notion/types.js';
import { assertNoSymlinkEscape } from '../filesystem/safe-path.js';
import { redactSecrets } from '../errors.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}
export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}
interface DoctorOptions {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  client?: Pick<NotionClient, 'retrievePage'>;
}

async function canWrite(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node_version',
    ok: major >= 22,
    message: `Node ${process.versions.node}`,
  });
  try {
    const config = await loadConfig(options.configPath, options.env);
    checks.push({
      name: 'config',
      ok: true,
      message: 'Configuration is valid',
    });
    checks.push({
      name: 'notion_token',
      ok: true,
      message: 'NOTION_TOKEN is set',
    });
    checks.push({ name: 'vault_path', ok: true, message: 'Vault path exists' });
    checks.push({
      name: 'managed_path',
      ok: true,
      message: 'Managed path is safely contained in the Vault',
    });
    const stateParent = dirname(config.state.databasePath);
    const stateParentWritable =
      (await canWrite(stateParent)) || (await canWrite(dirname(stateParent)));
    checks.push({
      name: 'state_database',
      ok: stateParentWritable,
      message: stateParentWritable
        ? 'State database location is writable'
        : 'State database location is not writable',
    });
    const writable = await canWrite(config.obsidian.vaultPath);
    checks.push({
      name: 'write_permission',
      ok: writable,
      message: writable ? 'Vault is writable' : 'Vault is not writable',
    });
    let symlinkSafe = true;
    try {
      await assertNoSymlinkEscape(
        {
          async isSymbolicLink(path) {
            try {
              return (await lstat(path)).isSymbolicLink();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return false;
              throw error;
            }
          },
        },
        config.obsidian.vaultPath,
        config.obsidian.managedPath,
      );
    } catch {
      symlinkSafe = false;
    }
    checks.push({
      name: 'symlink_safety',
      ok: symlinkSafe,
      message: symlinkSafe
        ? 'Managed path has no symbolic link escape'
        : 'Managed path contains a symbolic link escape',
    });
    const client =
      options.client ??
      new NotionSdkClient({
        token: config.notion.token,
        requestRatePerSecond: config.notion.requestRatePerSecond,
        concurrency: config.notion.concurrency,
      });
    let notionConnected = true;
    let notionMessage = 'All configured roots are readable';
    try {
      for (const root of config.notion.roots) {
        await client.retrievePage(root.pageId);
      }
    } catch (error) {
      notionConnected = false;
      notionMessage = redactSecrets(
        error instanceof Error ? error.message : 'Notion connection failed',
        [config.notion.token],
      );
    }
    checks.push({
      name: 'notion_connection',
      ok: notionConnected,
      message: notionMessage,
    });
    checks.push({
      name: 'root_read_permission',
      ok: notionConnected,
      message: notionConnected
        ? 'Configured roots are readable'
        : 'One or more configured roots are not readable',
    });
    checks.push({
      name: 'api_version',
      ok: true,
      message: 'Notion API version 2026-03-11 is configured',
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown configuration error';
    checks.push({ name: 'config', ok: false, message });
    checks.push({
      name: 'notion_token',
      ok: Boolean(options.env?.NOTION_TOKEN),
      message: options.env?.NOTION_TOKEN
        ? 'NOTION_TOKEN is set'
        : 'NOTION_TOKEN is missing',
    });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
