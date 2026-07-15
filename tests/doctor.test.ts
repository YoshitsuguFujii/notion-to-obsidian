import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';

describe('doctor', () => {
  it('ローカル基盤の検査結果を返し Token 値を出力しない', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-doctor-'));
    await mkdir(join(directory, 'vault'));
    const configPath = join(directory, 'config.yaml');
    await writeFile(
      configPath,
      `notion: { roots: [{ page_id: root-id, local_name: Notes }] }\nobsidian: { vault_path: ./vault, managed_path: Mirror }\nstate: { database_path: ./.state/state.db }`,
    );

    const result = await runDoctor({
      configPath,
      env: { NOTION_TOKEN: 'secret-token' },
      client: {
        retrievePage: () => Promise.resolve({ object: 'page', id: 'root-id' }),
      },
    });

    expect(result.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'node_version',
        'config',
        'notion_token',
        'vault_path',
        'managed_path',
        'state_database',
        'write_permission',
        'notion_connection',
        'root_read_permission',
        'symlink_safety',
        'api_version',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(result.ok).toBe(true);
  });
});
