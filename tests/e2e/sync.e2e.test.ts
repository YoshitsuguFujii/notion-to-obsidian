import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHttpDownloader } from '../../src/assets/http-downloader.js';
import { retrieveMarkdownWithFallback } from '../../src/notion/markdown.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { runStatus } from '../../src/commands/status.js';
import {
  CHILD_ID,
  PARENT_A_ID,
  PARENT_B_ID,
  ROOT_B_ID,
  ROOT_ID,
  SIBLING_ID,
  childPage,
  createSyncHarness,
  rootPage,
  type MockPage,
  type SyncHarness,
} from './sync-harness.js';

const harnesses: SyncHarness[] = [];

async function harness(
  pages: MockPage[],
  options?: Parameters<typeof createSyncHarness>[1],
) {
  const value = await createSyncHarness(pages, options);
  harnesses.push(value);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.close()));
});

describe('sync E2E', () => {
  it('親子関係にある同期ルートを重複ページと対処方法を示して拒否する', async () => {
    const app = await harness([rootPage(), childPage()]);
    app.config.notion.roots = [
      { pageId: ROOT_ID, localName: 'Notes' },
      { pageId: CHILD_ID, localName: 'Child root' },
    ];

    await expect(app.sync()).rejects.toThrow(
      new RegExp(`${CHILD_ID}.*${ROOT_ID}.*${CHILD_ID}.*Remove`, 'u'),
    );
  });

  it('重複と無関係なページだけを同期する場合も親子関係にある同期ルートを拒否する', async () => {
    const app = await harness([
      rootPage(),
      childPage(),
      childPage({ id: SIBLING_ID, title: 'Sibling' }),
    ]);
    app.config.notion.roots = [
      { pageId: ROOT_ID, localName: 'Notes' },
      { pageId: CHILD_ID, localName: 'Child root' },
    ];

    await expect(app.sync({ pageId: SIBLING_ID })).rejects.toThrow(
      new RegExp(`${CHILD_ID}.*${ROOT_ID}.*${CHILD_ID}.*Remove`, 'u'),
    );
  });

  it('Data Source行を別の同期ルートに指定した構成を重複ページと対処方法を示して拒否する', async () => {
    const databaseId = '77777777-7777-4777-8777-777777777777';
    const dataSourceId = '88888888-8888-4888-8888-888888888888';
    const rowRoot = {
      id: ROOT_B_ID,
      title: 'Row root',
      markdown: '# Row root\n',
    };
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: databaseId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        }),
        rowRoot,
      ],
      {
        dataSources: [
          {
            id: dataSourceId,
            name: 'Tasks',
            databaseId,
            rows: [{ ...rowRoot, parentId: databaseId }],
          },
        ],
      },
    );
    app.config.notion.roots = [
      { pageId: ROOT_ID, localName: 'Notes' },
      { pageId: ROOT_B_ID, localName: 'Row root' },
    ];

    await expect(app.sync()).rejects.toThrow(
      new RegExp(`${ROOT_B_ID}.*${ROOT_ID}.*${ROOT_B_ID}.*Remove`, 'u'),
    );
  });

  it('Data Source行だけを同期する場合も別の同期ルートとの重複を拒否する', async () => {
    const databaseId = '77777777-7777-4777-8777-777777777777';
    const dataSourceId = '88888888-8888-4888-8888-888888888888';
    const rowRoot = {
      id: ROOT_B_ID,
      title: 'Row root',
      markdown: '# Row root\n',
    };
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: databaseId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        }),
        rowRoot,
      ],
      {
        dataSources: [
          {
            id: dataSourceId,
            name: 'Tasks',
            databaseId,
            rows: [{ ...rowRoot, parentId: databaseId }],
          },
        ],
      },
    );
    app.config.notion.roots = [
      { pageId: ROOT_ID, localName: 'Notes' },
      { pageId: ROOT_B_ID, localName: 'Row root' },
    ];

    await expect(app.sync({ pageId: ROOT_B_ID })).rejects.toThrow(
      new RegExp(`${ROOT_B_ID}.*${ROOT_ID}.*${ROOT_B_ID}.*Remove`, 'u'),
    );
  });

  it('外部親を持つ同期ルートを最上位へ配置し親IDを保存しない', async () => {
    const app = await harness([rootPage({ parentId: 'outside-page' })]);

    await app.sync();

    const markdown = await readFile(join(app.managedRoot, 'Notes.md'), 'utf8');
    expect(markdown).toContain('notion_parent_id: null');
    expect(app.store.getResource(ROOT_ID)?.localPath).toBe('Notes.md');
  });

  it('一般ブロック内にネストした子ページを同期する', async () => {
    const toggleId = '77777777-7777-4777-8777-777777777777';
    const nested = childPage({
      title: 'Nested',
      discoverableAsChild: false,
      markdown: '# Nested body\n',
    });
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: toggleId,
              type: 'toggle',
              toggle: {},
              has_children: true,
            },
          ],
        }),
        nested,
      ],
      {
        blockChildren: {
          [toggleId]: [
            {
              id: nested.id,
              type: 'child_page',
              child_page: { title: nested.title },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        },
      },
    );

    await app.sync();

    await expect(
      readFile(join(app.managedRoot, 'Notes', 'Nested.md'), 'utf8'),
    ).resolves.toContain('# Nested body');
  });

  it('Search失敗時は不在resourceをmissingまたはTRASHにしない', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage()]);
    app.failSearch(true);

    const result = await app.sync();

    expect(result.partial).toBe(true);
    expect(result.actions.some(({ type }) => type === 'TRASH')).toBe(false);
    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      status: 'active',
      missingCount: 0,
    });
  });

  it('設定した退避割合を超える場合はファイルを退避せず同期を中止する', async () => {
    const children = Array.from({ length: 10 }, (_, index) =>
      childPage({
        id: `${String(index + 10).padStart(8, '0')}-aaaa-4aaa-8aaa-${String(index + 10).padStart(12, '0')}`,
        title: `Child ${index + 1}`,
      }),
    );
    const app = await harness([rootPage(), ...children]);
    await app.sync();
    app.config.sync.maximum_trash_ratio = 0.01;
    app.setPages([
      rootPage(),
      ...children.map((page, index) =>
        index === 0 ? { ...page, inTrash: true } : page,
      ),
    ]);

    await app.sync();
    await expect(app.sync()).rejects.toThrow('trash safety limit');

    expect(app.store.getResource(children[0]!.id)?.status).toBe('missing');
    expect(await exists(join(app.managedRoot, 'Notes', 'Child 1.md'))).toBe(
      true,
    );
  });

  it('管理対象Markdownが欠落している場合はNotionの内容から再作成する', async () => {
    const app = await harness([rootPage()]);
    await app.sync();
    const path = join(app.managedRoot, 'Notes.md');
    await rm(path);

    const result = await app.sync();

    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'UPDATE', notionId: ROOT_ID }),
    );
    await expect(readFile(path, 'utf8')).resolves.toContain('# Root');
  });

  it('管理対象Markdownの本文が改変されている場合はNotionの内容へ復旧する', async () => {
    const app = await harness([rootPage()]);
    await app.sync();
    const path = join(app.managedRoot, 'Notes.md');
    const content = await readFile(path, 'utf8');
    await writeFile(path, content.replace('# Root', '# Local edit'));

    const result = await app.sync();

    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'UPDATE', notionId: ROOT_ID }),
    );
    const restored = await readFile(path, 'utf8');
    expect(restored).toContain('# Root');
    expect(restored).not.toContain('# Local edit');
  });

  it('管理情報が一致しないMarkdownは上書きしない', async () => {
    const app = await harness([rootPage()]);
    await app.sync();
    const path = join(app.managedRoot, 'Notes.md');
    await writeFile(path, '# Personal note\n');

    await expect(app.sync()).rejects.toThrow('unmanaged file');

    await expect(readFile(path, 'utf8')).resolves.toBe('# Personal note\n');
  });

  it('別ルートへ移動したページの保存先を維持し次の同期では変更しない', async () => {
    const app = await harness([
      rootPage(),
      rootPage({ id: ROOT_B_ID, title: 'Root B', markdown: '# Root B\n' }),
      childPage(),
    ]);
    app.config.notion.roots = [
      { pageId: ROOT_ID, localName: 'Notes A' },
      { pageId: ROOT_B_ID, localName: 'Notes B' },
    ];
    await app.sync();
    app.setPages([
      rootPage(),
      rootPage({ id: ROOT_B_ID, title: 'Root B', markdown: '# Root B\n' }),
      childPage({ parentId: ROOT_B_ID }),
    ]);

    await app.sync();
    const moved = app.store.getResource(CHILD_ID);
    expect(moved).toMatchObject({
      rootId: ROOT_B_ID,
      localPath: 'Notes B/Child.md',
      missingCount: 0,
    });

    const second = await app.sync();
    expect(second.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: CHILD_ID }),
    );
    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      rootId: ROOT_B_ID,
      localPath: 'Notes B/Child.md',
    });
  });

  it('設定から削除したルートのページを猶予期間後に安全退避する', async () => {
    const app = await harness([
      rootPage(),
      rootPage({ id: ROOT_B_ID, title: 'Root B', markdown: '# Root B\n' }),
      childPage({ parentId: ROOT_B_ID }),
    ]);
    app.config.notion.roots = [
      { pageId: ROOT_ID, localName: 'Notes A' },
      { pageId: ROOT_B_ID, localName: 'Notes B' },
    ];
    await app.sync();
    app.config.notion.roots = [{ pageId: ROOT_ID, localName: 'Notes A' }];

    await app.sync();
    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      status: 'missing',
      missingCount: 1,
    });

    await app.sync({ allowLargeTrash: true });
    const stored = app.store.getResource(CHILD_ID);
    expect(stored).toMatchObject({
      status: 'tombstoned',
      trashReason: 'root_removed_from_config',
    });
    expect(stored?.localPath).toMatch(/^\.trash\/2026-07-12\//u);
  });

  it('1. 初回同期でページを作成する', async () => {
    const app = await harness([rootPage()]);
    const result = await app.sync();
    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'CREATE', notionId: ROOT_ID }),
    );
    await expect(
      readFile(join(app.managedRoot, 'Notes.md'), 'utf8'),
    ).resolves.toContain('# Root');
    expect(app.store.getResource(ROOT_ID)?.status).toBe('active');
  });

  it('2. 2回目同期で内容とmtimeを変更しない', async () => {
    const app = await harness([rootPage()]);
    await app.sync();
    const path = join(app.managedRoot, 'Notes.md');
    const content = await readFile(path, 'utf8');
    const mtime = (await stat(path)).mtimeMs;
    const result = await app.sync();
    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
    );
    expect(await readFile(path, 'utf8')).toBe(content);
    expect((await stat(path)).mtimeMs).toBe(mtime);
  });

  it('3. 子ページだけの更新を反映する', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    const parentPath = join(app.managedRoot, 'Notes.md');
    const parentMtime = (await stat(parentPath)).mtimeMs;
    app.setPages([
      rootPage(),
      childPage({
        markdown: '# Child changed\n',
        lastEditedTime: '2026-07-12T02:00:00.000Z',
      }),
    ]);
    const result = await app.sync();
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
        expect.objectContaining({ type: 'UPDATE', notionId: CHILD_ID }),
      ]),
    );
    expect((await stat(parentPath)).mtimeMs).toBe(parentMtime);
    await expect(
      readFile(join(app.managedRoot, 'Notes', 'Child.md'), 'utf8'),
    ).resolves.toContain('Child changed');
  });

  it('4. 親が未更新でも子ページの更新を検出する', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([
      rootPage({ lastEditedTime: '2026-07-12T00:00:00.000Z' }),
      childPage({
        markdown: 'new child body',
        lastEditedTime: '2026-07-12T03:00:00.000Z',
      }),
    ]);
    const result = await app.sync();
    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'UPDATE', notionId: CHILD_ID }),
    );
  });

  it('5. タイトル変更をMOVEとして扱う', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage(), childPage({ title: 'Renamed' })]);
    const result = await app.sync();
    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'MOVE', notionId: CHILD_ID }),
    );
    expect(await exists(join(app.managedRoot, 'Notes', 'Renamed.md'))).toBe(
      true,
    );
  });

  it('6. 改名後に旧ファイルを残さない', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage(), childPage({ title: 'Renamed' })]);
    await app.sync();
    expect(await exists(join(app.managedRoot, 'Notes', 'Child.md'))).toBe(
      false,
    );
  });

  it('MOVE衝突の確定パスをdry-run・WikiLink・実同期で一貫して使う', async () => {
    const childLink = `https://www.notion.so/${CHILD_ID.replaceAll('-', '')}`;
    const app = await harness([
      rootPage({ markdown: `[Child](${childLink})` }),
      childPage(),
    ]);
    await app.sync();
    const occupiedPath = join(app.managedRoot, 'Notes', 'Renamed.md');
    await writeFile(occupiedPath, '# Personal note\n');
    app.setPages([
      rootPage({
        markdown: `[Child](${childLink})`,
        lastEditedTime: '2026-07-12T02:00:00.000Z',
      }),
      childPage({ title: 'Renamed' }),
    ]);

    const fallbackPath = 'Notes/Renamed--44444444.md';
    const dryRun = await app.sync({ dryRun: true });
    expect(dryRun.actions).toContainEqual(
      expect.objectContaining({
        type: 'MOVE',
        notionId: CHILD_ID,
        path: fallbackPath,
      }),
    );

    await app.sync();

    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      localPath: fallbackPath,
      expectedPath: fallbackPath,
      resolvedFilename: 'Renamed--44444444',
    });
    expect(await exists(join(app.managedRoot, fallbackPath))).toBe(true);
    await expect(readFile(occupiedPath, 'utf8')).resolves.toBe(
      '# Personal note\n',
    );
    await expect(
      readFile(join(app.managedRoot, 'Notes.md'), 'utf8'),
    ).resolves.toContain('[[Notes/Renamed--44444444|Child]]');

    const second = await app.sync();
    expect(second.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: CHILD_ID }),
    );
  });

  it('7. ページを別の親階層へMOVEする', async () => {
    const parents = [
      childPage({ id: PARENT_A_ID, title: 'Parent A' }),
      childPage({ id: PARENT_B_ID, title: 'Parent B' }),
    ];
    const app = await harness([
      rootPage(),
      ...parents,
      childPage({ parentId: PARENT_A_ID }),
    ]);
    await app.sync();
    app.setPages([
      rootPage(),
      ...parents,
      childPage({ parentId: PARENT_B_ID }),
    ]);
    const result = await app.sync();
    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'MOVE', notionId: CHILD_ID }),
    );
    expect(
      await exists(join(app.managedRoot, 'Notes', 'Parent B', 'Child.md')),
    ).toBe(true);
  });

  it('8. 階層移動後に空の旧ディレクトリを残さない', async () => {
    const parents = [
      childPage({ id: PARENT_A_ID, title: 'Parent A' }),
      childPage({ id: PARENT_B_ID, title: 'Parent B' }),
    ];
    const app = await harness([
      rootPage(),
      ...parents,
      childPage({ parentId: PARENT_A_ID }),
    ]);
    await app.sync();
    app.setPages([
      rootPage(),
      ...parents,
      childPage({ parentId: PARENT_B_ID }),
    ]);
    await app.sync();
    expect(await exists(join(app.managedRoot, 'Notes', 'Parent A'))).toBe(
      false,
    );
  });

  it('9. 同名ページを決定論的ID suffixで衝突回避する', async () => {
    const app = await harness([
      rootPage(),
      childPage({ title: 'Memo' }),
      childPage({ id: SIBLING_ID, title: 'Memo' }),
    ]);
    await app.sync();
    const paths = app.store
      .listResources()
      .filter(({ title }) => title === 'Memo')
      .map(({ localPath }) => localPath)
      .sort();
    expect(new Set(paths).size).toBe(2);
    expect(paths.some((path) => path?.includes('55555555'))).toBe(true);
  });

  it('10. Notionのゴミ箱へ移したページは連続確認回数に達したときだけ退避する', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage(), childPage({ inTrash: true })]);
    const first = await app.sync({ allowLargeTrash: true });
    expect(first.actions).not.toContainEqual(
      expect.objectContaining({ type: 'TRASH', notionId: CHILD_ID }),
    );
    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      status: 'missing',
      missingCount: 1,
    });
    expect(runStatus(app.store).resourceCounts.missing).toBe(1);

    const second = await app.sync({ allowLargeTrash: true });
    expect(second.actions).toContainEqual(
      expect.objectContaining({ type: 'TRASH', notionId: CHILD_ID }),
    );
    expect(app.store.getResource(CHILD_ID)?.status).toBe('tombstoned');
    expect(app.store.getResource(CHILD_ID)?.trashReason).toBe(
      'notion_in_trash',
    );
  });

  it('11. grace runs経過後に不在ページを.trashへ移す', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage()]);
    await app.sync();
    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      status: 'missing',
      missingCount: 1,
    });
    await app.sync({ allowLargeTrash: true });
    const stored = app.store.getResource(CHILD_ID);
    expect(stored?.status).toBe('tombstoned');
    expect(stored?.localPath).toMatch(/^\.trash\/2026-07-12\//u);
    expect(await exists(join(app.managedRoot, stored!.localPath!))).toBe(true);
  });

  it('不在だったページを再発見するとactiveへ戻す', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage()]);
    await app.sync();
    expect(app.store.getResource(CHILD_ID)?.status).toBe('missing');

    app.setPages([rootPage(), childPage()]);
    await app.sync();

    expect(app.store.getResource(CHILD_ID)).toMatchObject({
      status: 'active',
      missingCount: 0,
    });
  });

  it('12. Root API失敗のpartial censusで大量退避しない', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.failRoot(true);
    const result = await app.sync();
    expect(result.partial).toBe(true);
    expect(result.actions.some(({ type }) => type === 'TRASH')).toBe(false);
    expect(app.store.getResource(CHILD_ID)?.status).toBe('active');
  });

  it('13. 添付ファイルを取得しローカル相対参照へ変換する', async () => {
    const assetUrl = 'https://files.example/photo.png?signature=temporary';
    const blockId = '66666666-6666-4666-8666-666666666666';
    const app = await harness([
      rootPage({
        markdown: `![Photo](${assetUrl})`,
        blocks: [
          {
            id: blockId,
            type: 'image',
            image: { type: 'file', file: { url: assetUrl }, caption: [] },
          },
        ],
      }),
    ]);
    await app.sync();
    const markdown = await readFile(join(app.managedRoot, 'Notes.md'), 'utf8');
    expect(markdown).toContain(`_assets/${ROOT_ID}/${blockId}--photo.png`);
    expect(markdown).not.toContain('signature=temporary');
    expect(app.store.listAssets()).toHaveLength(1);
  });

  it('child databaseをData Sourceのindexと行ページへ同期する', async () => {
    const databaseId = '77777777-7777-4777-8777-777777777777';
    const dataSourceId = '88888888-8888-4888-8888-888888888888';
    const rowId = '99999999-9999-4999-8999-999999999999';
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: databaseId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        }),
      ],
      {
        dataSources: [
          {
            id: dataSourceId,
            name: 'Tasks',
            databaseId,
            rows: [
              {
                id: rowId,
                title: 'First task',
                parentId: databaseId,
                markdown: '# Task body\n',
              },
            ],
          },
        ],
      },
    );

    await app.sync();

    await expect(
      readFile(join(app.managedRoot, 'Notes', 'Tasks', '_index.md'), 'utf8'),
    ).resolves.toContain('First task');
    await expect(
      readFile(
        join(app.managedRoot, 'Notes', 'Tasks', 'First task.md'),
        'utf8',
      ),
    ).resolves.toContain('# Task body');
  });

  it('Data Sourceのdatabase IDを指定すると行一覧のindexだけを出力する', async () => {
    const databaseId = '77777777-7777-4777-8777-777777777777';
    const dataSourceId = '88888888-8888-4888-8888-888888888888';
    const rowId = '99999999-9999-4999-8999-999999999999';
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: databaseId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        }),
      ],
      {
        dataSources: [
          {
            id: dataSourceId,
            name: 'Tasks',
            databaseId,
            rows: [
              {
                id: rowId,
                title: 'First task',
                parentId: databaseId,
                markdown: '# Task body\n',
              },
            ],
          },
        ],
      },
    );

    await app.sync({ pageId: databaseId });

    await expect(
      readFile(join(app.managedRoot, 'Notes', 'Tasks', '_index.md'), 'utf8'),
    ).resolves.toContain('First task');
    await expect(
      access(join(app.managedRoot, 'Notes', 'Tasks', 'First task.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('複数のdatabaseが同じData Sourceを参照しても行を初出のdatabaseに一度だけ同期する', async () => {
    const databaseId = '77777777-7777-4777-8777-777777777777';
    const linkedDatabaseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const dataSourceId = '88888888-8888-4888-8888-888888888888';
    const rowId = '99999999-9999-4999-8999-999999999999';
    const row = {
      id: rowId,
      title: 'First task',
      parentId: databaseId,
      markdown: '# Task body\n',
    };
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: databaseId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
            {
              id: linkedDatabaseId,
              type: 'child_database',
              child_database: { title: 'Linked tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        }),
        {
          id: linkedDatabaseId,
          title: 'Linked tasks',
          markdown: '# Linked tasks\n',
        },
      ],
      {
        dataSources: [
          { id: dataSourceId, name: 'Tasks', databaseId, rows: [row] },
          {
            id: dataSourceId,
            name: 'Tasks',
            databaseId: linkedDatabaseId,
            rows: [row],
          },
        ],
      },
    );

    await app.sync();

    await expect(
      readFile(
        join(app.managedRoot, 'Notes', 'Tasks', 'First task.md'),
        'utf8',
      ),
    ).resolves.toContain('# Task body');
    expect(app.store.getResource(rowId)?.localPath).toBe(
      'Notes/Tasks/First task.md',
    );
    await expect(
      access(join(app.managedRoot, 'Notes', 'Linked tasks', 'First task.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Data Source行のpage IDを指定して行ページだけを同期する', async () => {
    const databaseId = '77777777-7777-4777-8777-777777777777';
    const dataSourceId = '88888888-8888-4888-8888-888888888888';
    const rowId = '99999999-9999-4999-8999-999999999999';
    const app = await harness(
      [
        rootPage({
          blocks: [
            {
              id: databaseId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
              parent: { type: 'page_id', page_id: ROOT_ID },
              last_edited_time: '2026-07-12T00:00:00.000Z',
              in_trash: false,
            },
          ],
        }),
      ],
      {
        dataSources: [
          {
            id: dataSourceId,
            name: 'Tasks',
            databaseId,
            rows: [
              {
                id: rowId,
                title: 'First task',
                parentId: databaseId,
                markdown: '# Task body\n',
              },
            ],
          },
        ],
      },
    );

    await app.sync({ pageId: rowId });

    await expect(
      readFile(
        join(app.managedRoot, 'Notes', 'Tasks', 'First task.md'),
        'utf8',
      ),
    ).resolves.toContain('# Task body');
    expect(app.store.getResource(rowId)).toMatchObject({
      status: 'active',
      localPath: 'Notes/Tasks/First task.md',
    });
  });

  it('許可外のContent-Typeを返すアセットは保存せずリモート参照を維持する', async () => {
    const assetUrl = 'https://files.example/photo.png';
    const blockId = '77777777-7777-4777-8777-777777777777';
    const downloader = new NodeHttpDownloader({
      validateUrl: () => Promise.resolve(),
      fetch: () =>
        Promise.resolve(
          new Response('not an image', {
            headers: { 'content-type': 'text/html' },
          }),
        ),
    });
    const app = await harness(
      [
        rootPage({
          markdown: `![Photo](${assetUrl})`,
          blocks: [
            {
              id: blockId,
              type: 'image',
              image: { type: 'file', file: { url: assetUrl }, caption: [] },
            },
          ],
        }),
      ],
      { downloadAsset: (request) => downloader.download(request) },
    );

    await app.sync();

    const markdown = await readFile(join(app.managedRoot, 'Notes.md'), 'utf8');
    expect(markdown).toContain(assetUrl);
    expect(app.store.listAssets()).toEqual([]);
    expect(await exists(join(app.managedRoot, '_assets', ROOT_ID))).toBe(false);
  });

  it('許可外の拡張子を持つアセットは取得せずリモート参照を維持する', async () => {
    const assetUrl = 'https://files.example/photo.exe';
    const blockId = '88888888-8888-4888-8888-888888888888';
    const downloader = new NodeHttpDownloader({
      validateUrl: () => Promise.resolve(),
      fetch: () =>
        Promise.resolve(
          new Response('image', {
            headers: { 'content-type': 'image/png' },
          }),
        ),
    });
    const app = await harness(
      [
        rootPage({
          markdown: `![Photo](${assetUrl})`,
          blocks: [
            {
              id: blockId,
              type: 'image',
              image: { type: 'file', file: { url: assetUrl }, caption: [] },
            },
          ],
        }),
      ],
      { downloadAsset: (request) => downloader.download(request) },
    );

    await app.sync();

    const markdown = await readFile(join(app.managedRoot, 'Notes.md'), 'utf8');
    expect(markdown).toContain(assetUrl);
    expect(app.store.listAssets()).toEqual([]);
  });

  it.each([
    {
      extension: '.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { extension: '.zip', contentType: 'application/zip' },
    { extension: '.mov', contentType: 'video/quicktime' },
  ])(
    'Notion由来の$extension添付をローカルへ保存する',
    async ({ extension, contentType }) => {
      const assetUrl = `https://files.example/report${extension}?signature=temporary`;
      const blockId = '99999999-aaaa-4999-8999-999999999999';
      const downloader = new NodeHttpDownloader({
        validateUrl: () => Promise.resolve(),
        fetch: () =>
          Promise.resolve(
            new Response('document', {
              headers: {
                'content-type': contentType,
              },
            }),
          ),
      });
      const app = await harness(
        [
          rootPage({
            markdown: `[Report](${assetUrl})`,
            blocks: [
              {
                id: blockId,
                type: 'file',
                file: {
                  type: 'file',
                  file: { url: assetUrl },
                  name: `report${extension}`,
                  caption: [],
                },
              },
            ],
          }),
        ],
        { downloadAsset: (request) => downloader.download(request) },
      );

      await app.sync();

      const stored = app.store.listAssets()[0];
      expect(stored?.localPath).toMatch(
        new RegExp(`report\\${extension}$`, 'u'),
      );
      expect(await exists(join(app.managedRoot, stored!.localPath))).toBe(true);
      const markdown = await readFile(
        join(app.managedRoot, 'Notes.md'),
        'utf8',
      );
      expect(markdown).not.toContain('signature=temporary');
    },
  );

  it.each([
    {
      extension: '.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { extension: '.zip', contentType: 'application/zip' },
    { extension: '.mov', contentType: 'video/quicktime' },
  ])(
    '外部URL由来の$extension添付は既定では保存せずリモート参照を維持する',
    async ({ extension, contentType }) => {
      const assetUrl = `https://external.example/report${extension}`;
      const downloader = new NodeHttpDownloader({
        validateUrl: () => Promise.resolve(),
        fetch: () =>
          Promise.resolve(
            new Response('document', {
              headers: {
                'content-type': contentType,
              },
            }),
          ),
      });
      const app = await harness(
        [rootPage({ markdown: `![Report](${assetUrl})` })],
        { downloadAsset: (request) => downloader.download(request) },
      );
      app.config.sync.download_external_assets = true;

      await app.sync();

      const markdown = await readFile(
        join(app.managedRoot, 'Notes.md'),
        'utf8',
      );
      expect(markdown).toContain(assetUrl);
      expect(app.store.listAssets()).toEqual([]);
    },
  );

  it('14. アセットと併存する同期対象NotionリンクをWikiLinkへ変換する', async () => {
    const assetUrl = 'https://files.example/linked-photo.png';
    const assetBlockId = '99999999-9999-4999-8999-999999999999';
    const app = await harness([
      rootPage({
        markdown: [
          `[Child](https://www.notion.so/${CHILD_ID.replaceAll('-', '')})`,
          `![Photo](${assetUrl})`,
        ].join('\n\n'),
        blocks: [
          {
            id: assetBlockId,
            type: 'image',
            image: { type: 'file', file: { url: assetUrl }, caption: [] },
          },
        ],
      }),
      childPage(),
    ]);
    await app.sync();
    await expect(
      readFile(join(app.managedRoot, 'Notes.md'), 'utf8'),
    ).resolves.toContain('[[Notes/Child|Child]]');
  });

  it('15. 同期対象外のNotionリンクを外部リンクのまま保つ', async () => {
    const outside = '77777777777747778777777777777777';
    const link = `https://www.notion.so/${outside}`;
    const app = await harness([rootPage({ markdown: `[Outside](${link})` })]);
    await app.sync();
    await expect(
      readFile(join(app.managedRoot, 'Notes.md'), 'utf8'),
    ).resolves.toContain(`[Outside](${link})`);
  });

  it('16. 未対応ブロックをplaceholderとsidecarで保全する', async () => {
    const unsupportedId = '88888888-8888-4888-8888-888888888888';
    const app = await harness([
      rootPage({
        markdown: '<unknown>',
        markdownTruncated: true,
        unknownBlockIds: ['ambiguous-one', 'ambiguous-two'],
        blocks: [
          {
            id: unsupportedId,
            type: 'future_block',
            future_block: { answer: 42 },
          },
        ],
      }),
    ]);
    const retrieved = await retrieveMarkdownWithFallback(app.client, ROOT_ID);
    expect(retrieved.sidecars).toContainEqual(
      expect.objectContaining({ type: 'future_block', id: unsupportedId }),
    );
    await app.sync();
    const markdown = await readFile(join(app.managedRoot, 'Notes.md'), 'utf8');
    expect(markdown).toContain('Unsupported block:');
    expect(markdown).toContain('notion-to-obsidian: unsupported block');
    const sidecar: unknown = JSON.parse(
      await readFile(
        join(app.managedRoot, '_unsupported', ROOT_ID, `${unsupportedId}.json`),
        'utf8',
      ),
    );
    expect(sidecar).toEqual({
      type: 'future_block',
      id: unsupportedId,
      payload: {
        id: unsupportedId,
        type: 'future_block',
        future_block: { answer: 42 },
      },
    });
  });

  it('unsupported sidecarをdry-runで作成しない', async () => {
    const unsupportedId = '88888888-8888-4888-8888-888888888888';
    const app = await harness([
      rootPage({
        markdown: '<unknown>',
        markdownTruncated: true,
        unknownBlockIds: ['ambiguous-one', 'ambiguous-two'],
        blocks: [{ id: unsupportedId, type: 'future_block', future_block: {} }],
      }),
    ]);

    await app.sync({ dryRun: true });

    expect(await exists(join(app.managedRoot, '_unsupported'))).toBe(false);
  });

  it('欠落したunsupported sidecarをUNCHANGED同期で再生成する', async () => {
    const unsupportedId = '88888888-8888-4888-8888-888888888888';
    const app = await harness([
      rootPage({
        markdown: '<unknown>',
        markdownTruncated: true,
        unknownBlockIds: ['ambiguous-one', 'ambiguous-two'],
        blocks: [{ id: unsupportedId, type: 'future_block', future_block: {} }],
      }),
    ]);
    await app.sync();
    const markdownPath = join(app.managedRoot, 'Notes.md');
    const markdownMtime = (await stat(markdownPath)).mtimeMs;
    const sidecarPath = join(
      app.managedRoot,
      '_unsupported',
      ROOT_ID,
      `${unsupportedId}.json`,
    );
    const { rm } = await import('node:fs/promises');
    await rm(sidecarPath);

    const result = await app.sync();

    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
    );
    expect(await exists(sidecarPath)).toBe(true);
    expect((await stat(markdownPath)).mtimeMs).toBe(markdownMtime);
  });

  it('17. dry-runでファイルとDBを変更しない', async () => {
    const app = await harness([rootPage()]);
    const beforeResources = app.store.listResources();
    const beforeRuns = app.store.listUnfinishedRuns();
    await app.sync({ dryRun: true });
    expect(await exists(app.managedRoot)).toBe(false);
    expect(app.store.listResources()).toEqual(beforeResources);
    expect(app.store.listUnfinishedRuns()).toEqual(beforeRuns);
    expect(app.store.getLatestRun()).toBeUndefined();
  });

  it('dry-runでgrace runs到達予定のTRASHを表示して状態を変更しない', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage()]);
    await app.sync();
    const childPath = join(app.managedRoot, 'Notes', 'Child.md');
    const before = await stat(childPath);
    const beforeResources = app.store.listResources();
    const beforeRun = app.store.getLatestRun();

    const result = await app.sync({ dryRun: true, allowLargeTrash: true });

    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'TRASH', notionId: CHILD_ID }),
    );
    expect(app.store.listResources()).toEqual(beforeResources);
    expect(app.store.getLatestRun()).toEqual(beforeRun);
    expect((await stat(childPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await exists(join(app.managedRoot, '.trash'))).toBe(false);
  });

  it('dry-runのTRASH安全弁停止時も状態を変更しない', async () => {
    const app = await harness([rootPage(), childPage()]);
    await app.sync();
    app.setPages([rootPage()]);
    await app.sync();
    app.config.sync.maximum_trash_ratio = 0.01;
    const childPath = join(app.managedRoot, 'Notes', 'Child.md');
    const beforeResources = app.store.listResources();
    const beforeRun = app.store.getLatestRun();

    await expect(app.sync({ dryRun: true })).rejects.toThrow(
      'trash safety limit',
    );

    expect(app.store.listResources()).toEqual(beforeResources);
    expect(app.store.getLatestRun()).toEqual(beforeRun);
    expect(await exists(childPath)).toBe(true);
    expect(await exists(join(app.managedRoot, '.trash'))).toBe(false);
  });

  it('18. managed directory内の手書きファイルを変更しない', async () => {
    const app = await harness([rootPage()]);
    await mkdir(app.managedRoot, { recursive: true });
    const manualPath = join(app.managedRoot, 'Manual.md');
    await writeFile(manualPath, '# Personal note\n');
    const before = await stat(manualPath);
    await app.sync();
    expect(await readFile(manualPath, 'utf8')).toBe('# Personal note\n');
    expect((await stat(manualPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it('19. 中断runを検出して再実行時にcrash recoveryする', async () => {
    const app = await harness([rootPage()]);
    await app.sync();
    app.store.beginRun({
      runId: 'interrupted-run',
      startedAt: '2026-07-12T00:30:00.000Z',
      mode: 'incremental',
      configHash: 'interrupted',
      apiVersion: '2026-03-11',
      toolVersion: '0.1.0',
      transformVersion: '1',
    });
    const stable = await readFile(join(app.managedRoot, 'Notes.md'), 'utf8');
    const temporaryPath = join(app.managedRoot, 'Notes.recovery.tmp');
    await writeFile(temporaryPath, stable);

    const result = await app.sync();

    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
    );
    expect(await exists(temporaryPath)).toBe(false);
    expect(await readFile(join(app.managedRoot, 'Notes.md'), 'utf8')).toBe(
      stable,
    );
  });
});

describe('初回運用フロー E2E', () => {
  it('doctorからplan・dry-run・実同期・2回目の無変更まで実行できる', async () => {
    const app = await harness([rootPage()]);
    const configPath = join(app.vault, 'config.yaml');
    await writeFile(
      configPath,
      [
        'notion:',
        '  roots:',
        `    - page_id: '${ROOT_ID}'`,
        "      local_name: 'Notes'",
        'obsidian:',
        `  vault_path: '${app.vault}'`,
        "  managed_path: 'Mirror'",
        'state:',
        `  database_path: '${join(app.vault, 'state.db')}'`,
      ].join('\n'),
    );

    const doctor = await runDoctor({
      configPath,
      env: { NOTION_TOKEN: 'e2e-placeholder-token' },
      client: app.client,
    });
    expect(doctor.ok).toBe(true);

    const plan = await app.sync({ dryRun: true });
    const dryRun = await app.sync({ dryRun: true });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ type: 'CREATE', notionId: ROOT_ID }),
    );
    expect(dryRun.actions).toContainEqual(
      expect.objectContaining({ type: 'CREATE', notionId: ROOT_ID }),
    );
    expect(await exists(app.managedRoot)).toBe(false);
    expect(app.store.getLatestRun()).toBeUndefined();

    await app.sync();
    const path = join(app.managedRoot, 'Notes.md');
    const content = await readFile(path, 'utf8');
    const mtime = (await stat(path)).mtimeMs;
    const second = await app.sync();

    expect(second.actions).toContainEqual(
      expect.objectContaining({ type: 'UNCHANGED', notionId: ROOT_ID }),
    );
    expect(await readFile(path, 'utf8')).toBe(content);
    expect((await stat(path)).mtimeMs).toBe(mtime);
  });
});
