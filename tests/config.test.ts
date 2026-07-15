import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

async function fixture(yaml: string) {
  const directory = await mkdtemp(join(tmpdir(), 'notion-config-'));
  await mkdir(join(directory, 'vault'));
  const path = join(directory, 'config.yaml');
  await writeFile(path, yaml);
  return { directory, path };
}

describe('loadConfig', () => {
  it('YAML の設定を検証しパスを絶対パスへ変換する', async () => {
    const { directory, path } = await fixture(`
notion:
  roots:
    - page_id: root-id
      local_name: Notes
obsidian:
  vault_path: ./vault
  managed_path: Mirror
`);

    const config = await loadConfig(path, { NOTION_TOKEN: 'secret' });

    expect(config.obsidian.vaultPath).toBe(join(directory, 'vault'));
    expect(config.obsidian.managedPath).toBe(
      join(directory, 'vault', 'Mirror'),
    );
    expect(config.notion.token).toBe('secret');
    expect(config.notion.requestRatePerSecond).toBe(2.5);
    expect(config.notion.concurrency).toBe(2);
    expect(config.sync.notion_asset_allowed_content_types).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(config.sync.notion_asset_allowed_extensions).toContain('.docx');
    expect(config.sync.external_asset_allowed_content_types).toContain(
      'image/png',
    );
    expect(config.sync.external_asset_allowed_extensions).toContain('.png');
    expect(config.sync.external_asset_allowed_extensions).not.toContain(
      '.docx',
    );
  });

  it('廃止した共通asset許可リスト設定を拒否する', async () => {
    const { path } = await fixture(`
notion:
  roots: [{ page_id: root-id, local_name: Notes }]
obsidian: { vault_path: ./vault, managed_path: Mirror }
sync:
  allowed_content_types: [image/png]
  allowed_extensions: [.png]
`);

    await expect(loadConfig(path, { NOTION_TOKEN: 'secret' })).rejects.toThrow(
      /allowed_content_types/u,
    );
  });

  it('Token を YAML から受け付けない', async () => {
    const { path } = await fixture(`
notion:
  token: leaked
  roots: [{ page_id: root-id, local_name: Notes }]
obsidian: { vault_path: ./vault, managed_path: Mirror }
`);

    await expect(loadConfig(path, { NOTION_TOKEN: 'secret' })).rejects.toThrow(
      /token/i,
    );
  });

  it.each([
    ['Vault root', '.'],
    ['filesystem root', '/'],
    ['home directory', homedir()],
  ])('managed directory に危険な %s を拒否する', async (_, managedPath) => {
    const { path } = await fixture(`
notion:
  roots: [{ page_id: root-id, local_name: Notes }]
obsidian:
  vault_path: ./vault
  managed_path: ${JSON.stringify(managedPath)}
`);

    await expect(loadConfig(path, { NOTION_TOKEN: 'secret' })).rejects.toThrow(
      /managed/i,
    );
  });

  it('存在しない Vault を拒否する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-config-'));
    const path = join(directory, 'config.yaml');
    await writeFile(
      path,
      `notion: { roots: [{ page_id: root-id, local_name: Notes }] }\nobsidian: { vault_path: ./missing, managed_path: Mirror }`,
    );

    await expect(loadConfig(path, { NOTION_TOKEN: 'secret' })).rejects.toThrow(
      /Vault/i,
    );
  });
});
