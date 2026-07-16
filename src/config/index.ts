import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DomainError } from '../errors.js';

const rootSchema = z
  .object({ page_id: z.string().min(1), local_name: z.string().min(1) })
  .strict();
const rootsSchema = z
  .array(rootSchema)
  .min(1)
  .superRefine((roots, context) => {
    const seenPageIds = new Set<string>();
    roots.forEach((root, index) => {
      if (seenPageIds.has(root.page_id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'page_id'],
          message: `Duplicate notion root page_id: ${root.page_id}. Remove duplicate roots from notion.roots`,
        });
      }
      seenPageIds.add(root.page_id);
    });
  });
const defaultExternalAssetAllowedContentTypes = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
  'text/plain',
] as const;
const defaultExternalAssetAllowedExtensions = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.mp3',
  '.m4a',
  '.mp4',
  '.txt',
] as const;
const defaultNotionAssetAllowedContentTypes = [
  ...defaultExternalAssetAllowedContentTypes,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'video/quicktime',
  'image/heic',
  'audio/wav',
  'audio/x-wav',
  'text/csv',
  'text/markdown',
  'application/json',
] as const;
const defaultNotionAssetAllowedExtensions = [
  ...defaultExternalAssetAllowedExtensions,
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.mov',
  '.heic',
  '.wav',
  '.csv',
  '.md',
  '.json',
] as const;
const fileSchema = z
  .object({
    notion: z
      .object({
        roots: rootsSchema,
        request_rate_per_second: z.number().positive().default(2.5),
        concurrency: z.number().int().positive().default(2),
      })
      .strict(),
    obsidian: z
      .object({
        vault_path: z.string().min(1),
        managed_path: z.string().min(1),
      })
      .strict(),
    sync: z
      .object({
        deletion_grace_runs: z.number().int().positive().default(2),
        maximum_trash_ratio: z.number().min(0).max(1).default(0.2),
        maximum_trash_count: z.number().int().nonnegative().default(50),
        download_external_assets: z.boolean().default(false),
        maximum_asset_size_mb: z.number().positive().default(100),
        notion_asset_allowed_content_types: z
          .array(z.string().min(1))
          .min(1)
          .default([...defaultNotionAssetAllowedContentTypes]),
        notion_asset_allowed_extensions: z
          .array(z.string().regex(/^\.[a-z0-9]+$/iu))
          .min(1)
          .default([...defaultNotionAssetAllowedExtensions]),
        external_asset_allowed_content_types: z
          .array(z.string().min(1))
          .min(1)
          .default([...defaultExternalAssetAllowedContentTypes]),
        external_asset_allowed_extensions: z
          .array(z.string().regex(/^\.[a-z0-9]+$/iu))
          .min(1)
          .default([...defaultExternalAssetAllowedExtensions]),
      })
      .strict()
      .default({
        deletion_grace_runs: 2,
        maximum_trash_ratio: 0.2,
        maximum_trash_count: 50,
        download_external_assets: false,
        maximum_asset_size_mb: 100,
        notion_asset_allowed_content_types: [
          ...defaultNotionAssetAllowedContentTypes,
        ],
        notion_asset_allowed_extensions: [
          ...defaultNotionAssetAllowedExtensions,
        ],
        external_asset_allowed_content_types: [
          ...defaultExternalAssetAllowedContentTypes,
        ],
        external_asset_allowed_extensions: [
          ...defaultExternalAssetAllowedExtensions,
        ],
      }),
    logging: z
      .object({
        format: z.enum(['pretty', 'json']).default('pretty'),
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      })
      .default({ format: 'pretty', level: 'info' }),
    state: z
      .object({
        database_path: z
          .string()
          .min(1)
          .default('./.state/notion-to-obsidian.db'),
      })
      .default({ database_path: './.state/notion-to-obsidian.db' }),
  })
  .strict();

function expandPath(value: string, base: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export interface AppConfig {
  notion: {
    roots: Array<{ pageId: string; localName: string }>;
    requestRatePerSecond: number;
    concurrency: number;
    token: string;
  };
  obsidian: { vaultPath: string; managedPath: string };
  sync: z.infer<typeof fileSchema>['sync'];
  logging: z.infer<typeof fileSchema>['logging'];
  state: { databasePath: string };
}

export async function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const token = env.NOTION_TOKEN;
  if (!token) throw new DomainError('validation', 'NOTION_TOKEN is required');
  let parsed: z.infer<typeof fileSchema>;
  try {
    parsed = fileSchema.parse(parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    throw new DomainError(
      'validation',
      `Invalid config: ${error instanceof Error ? error.message : 'unknown error'}`,
      {
        cause: error,
        secrets: [token],
      },
    );
  }
  const base = dirname(resolve(configPath));
  const vaultPath = expandPath(parsed.obsidian.vault_path, base);
  try {
    await access(vaultPath);
  } catch (error) {
    throw new DomainError(
      'validation',
      `Vault path does not exist: ${vaultPath}`,
      { cause: error },
    );
  }
  const rawManaged = parsed.obsidian.managed_path;
  const managedPath = isAbsolute(rawManaged)
    ? expandPath(rawManaged, base)
    : resolve(vaultPath, rawManaged);
  const managedRelativePath = relative(vaultPath, managedPath);
  const managedPathIsDescendant =
    managedRelativePath !== '' &&
    !managedRelativePath.startsWith('..') &&
    !isAbsolute(managedRelativePath);
  if (
    managedPath === vaultPath ||
    managedPath === resolve('/') ||
    managedPath === resolve(homedir()) ||
    !managedPathIsDescendant
  ) {
    throw new DomainError('safety', 'Unsafe managed path');
  }
  return {
    notion: {
      roots: parsed.notion.roots.map((root) => ({
        pageId: root.page_id,
        localName: root.local_name,
      })),
      requestRatePerSecond: parsed.notion.request_rate_per_second,
      concurrency: parsed.notion.concurrency,
      token,
    },
    obsidian: { vaultPath, managedPath },
    sync: parsed.sync,
    logging: parsed.logging,
    state: {
      databasePath: expandPath(
        parsed.state.database_path ?? './.state/notion-to-obsidian.db',
        base,
      ),
    },
  };
}
