import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSyncPlan } from '../src/sync/plan-validator.js';

const managedRoot = resolve('/tmp/notion-managed');
const vaultRoot = resolve('/tmp/notion-vault');
const validPlan = {
  managedRoot,
  vaultRoot,
  censusComplete: true,
  managedResourceCount: 10,
  allowLargeTrash: false,
  actions: [
    {
      type: 'WRITE' as const,
      notionId: 'page-1',
      targetPath: join(managedRoot, 'Page.md'),
    },
  ],
};

describe('validateSyncPlan', () => {
  it('managed 外への書き込みを拒否する', async () => {
    await expect(
      validateSyncPlan({
        ...validPlan,
        actions: [
          { type: 'WRITE', notionId: 'page-1', targetPath: '/tmp/outside.md' },
        ],
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('symlink 経由の書き込みを拒否する', async () => {
    await expect(
      validateSyncPlan(validPlan, {
        isSymbolicLink: (path) => Promise.resolve(path.endsWith('Page.md')),
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('同一出力パスへの複数ページ割当を拒否する', async () => {
    await expect(
      validateSyncPlan({
        ...validPlan,
        actions: [
          ...validPlan.actions,
          {
            type: 'WRITE',
            notionId: 'page-2',
            targetPath: join(managedRoot, 'Page.md'),
          },
        ],
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('managed root 自体の削除を拒否する', async () => {
    await expect(
      validateSyncPlan({
        ...validPlan,
        actions: [
          {
            type: 'TRASH',
            notionId: 'root',
            sourcePath: managedRoot,
            managed: true,
          },
        ],
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it.each([parse(resolve('/')).root, homedir(), vaultRoot])(
    '危険な managed root %s を拒否する',
    async (dangerousRoot) => {
      await expect(
        validateSyncPlan({ ...validPlan, managedRoot: dangerousRoot }),
      ).rejects.toMatchObject({ category: 'safety' });
    },
  );

  it('partial census の削除 action を拒否する', async () => {
    await expect(
      validateSyncPlan({
        ...validPlan,
        censusComplete: false,
        actions: [
          {
            type: 'TRASH',
            notionId: 'page-1',
            sourcePath: join(managedRoot, 'Page.md'),
            managed: true,
          },
        ],
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('management marker と DB が一致しない削除 action を拒否する', async () => {
    await expect(
      validateSyncPlan({
        ...validPlan,
        actions: [
          {
            type: 'TRASH',
            notionId: 'page-1',
            sourcePath: join(managedRoot, 'Page.md'),
            managed: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('管理対象外fileが残る出力先への上書きを拒否する', async () => {
    await expect(
      validateSyncPlan({
        ...validPlan,
        actions: [
          {
            type: 'WRITE',
            notionId: 'page-1',
            targetPath: join(managedRoot, 'Page.md'),
            targetState: 'unmanaged',
          },
        ],
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('大量退避を明示許可なしでは拒否する', async () => {
    const actions = Array.from({ length: 3 }, (_, index) => ({
      type: 'TRASH' as const,
      notionId: `page-${index}`,
      sourcePath: join(managedRoot, `Page-${index}.md`),
      managed: true,
    }));
    await expect(
      validateSyncPlan({ ...validPlan, actions }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('すべての安全条件を満たす plan を許可する', async () => {
    await expect(
      validateSyncPlan(validPlan, {
        isSymbolicLink: () => Promise.resolve(false),
      }),
    ).resolves.toBeUndefined();
  });
});
