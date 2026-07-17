import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocateOutputPaths } from '../src/sync/output-path-allocator.js';

const managedRoot = '/vault/Mirror';

function path(
  notionId: string,
  expectedPath: string,
  resolvedFilename = posix.basename(expectedPath, posix.extname(expectedPath)),
) {
  return { notionId, expectedPath, resolvedFilename };
}

function existingPaths(...relativePaths: string[]) {
  const paths = new Set(
    relativePaths.map((relativePath) => posix.join(managedRoot, relativePath)),
  );
  return (absolutePath: string) => Promise.resolve(paths.has(absolutePath));
}

function caseInsensitiveExistingPaths(...relativePaths: string[]) {
  const caseInsensitivePathKey = (value: string) =>
    value.normalize('NFC').toLocaleLowerCase('en-US');
  const paths = new Set(
    relativePaths.map((relativePath) =>
      caseInsensitivePathKey(posix.join(managedRoot, relativePath)),
    ),
  );
  return (absolutePath: string) =>
    Promise.resolve(paths.has(caseInsensitivePathKey(absolutePath)));
}

describe('allocateOutputPaths', () => {
  it('MOVE先にローカルファイルがあればID付きパスを割り当てる', async () => {
    const result = await allocateOutputPaths({
      paths: [path('11111111-1111-4111-8111-111111111111', 'New/Page.md')],
      existingById: new Map([
        ['11111111-1111-4111-8111-111111111111', { localPath: 'Old/Page.md' }],
      ]),
      managedRoot,
      exists: existingPaths('New/Page.md'),
    });

    expect(result.paths).toEqual([
      path(
        '11111111-1111-4111-8111-111111111111',
        'New/Page--11111111.md',
        'Page--11111111',
      ),
    ]);
    expect(result.warnings).toEqual([
      {
        notionId: '11111111-1111-4111-8111-111111111111',
        message: 'Unmanaged target collision used a deterministic fallback',
      },
    ]);
  });

  it('MOVE先が別リソースの計画パスならID付きパスを割り当てる', async () => {
    const result = await allocateOutputPaths({
      paths: [
        path('create-page', 'New/Page.md'),
        path('22222222-2222-4222-8222-222222222222', 'New/Page.md'),
      ],
      existingById: new Map([
        ['22222222-2222-4222-8222-222222222222', { localPath: 'Old/Page.md' }],
      ]),
      managedRoot,
      exists: existingPaths(),
    });

    expect(result.paths[1]?.expectedPath).toBe('New/Page--22222222.md');
  });

  it('大文字小文字だけ異なる計画パスとの衝突をID付きパスで回避する', async () => {
    const result = await allocateOutputPaths({
      paths: [
        path('create-page', 'New/page--ABCDEF12.md'),
        path('22222222-2222-4222-8222-222222222222', 'New/Page--abcdef12.md'),
      ],
      existingById: new Map([
        ['22222222-2222-4222-8222-222222222222', { localPath: 'Old/Page.md' }],
      ]),
      managedRoot,
      exists: existingPaths(),
    });

    expect(result.paths[1]?.expectedPath).toBe(
      'New/Page--abcdef12--22222222.md',
    );
  });

  it('Unicodeの合成形式だけ異なる計画パスとの衝突をID付きパスで回避する', async () => {
    const result = await allocateOutputPaths({
      paths: [
        path('create-page', 'New/Cafe\u0301.md'),
        path('33333333-3333-4333-8333-333333333333', 'New/Café.md'),
      ],
      existingById: new Map([
        ['33333333-3333-4333-8333-333333333333', { localPath: 'Old/Café.md' }],
      ]),
      managedRoot,
      exists: existingPaths(),
    });

    expect(result.paths[1]?.expectedPath).toBe('New/Café--33333333.md');
  });

  it('ID付きパスもローカルまたは別リソースに割り当て済みなら停止する', async () => {
    await expect(
      allocateOutputPaths({
        paths: [
          path('create-page', 'New/Page--33333333.md'),
          path('33333333-3333-4333-8333-333333333333', 'New/Page.md'),
        ],
        existingById: new Map([
          [
            '33333333-3333-4333-8333-333333333333',
            { localPath: 'Old/Page.md' },
          ],
        ]),
        managedRoot,
        exists: existingPaths('New/Page.md'),
      }),
    ).rejects.toMatchObject({ category: 'safety' });
  });

  it('ID付きパスにある自身のファイルは衝突として扱わない', async () => {
    const notionId = '44444444-4444-4444-8444-444444444444';
    const result = await allocateOutputPaths({
      paths: [path(notionId, 'New/Page.md')],
      existingById: new Map([
        [notionId, { localPath: 'New/Page--44444444.md' }],
      ]),
      managedRoot,
      exists: existingPaths('New/Page.md', 'New/Page--44444444.md'),
    });

    expect(result.paths[0]?.expectedPath).toBe('New/Page--44444444.md');
  });

  it('大文字小文字だけ異なる現在パスが存在すればID付きパスを割り当てる', async () => {
    const notionId = '55555555-5555-4555-8555-555555555555';
    const result = await allocateOutputPaths({
      paths: [path(notionId, 'Old/page.md')],
      existingById: new Map([[notionId, { localPath: 'Old/Page.md' }]]),
      managedRoot,
      exists: caseInsensitiveExistingPaths('Old/Page.md'),
    });

    expect(result.paths[0]?.expectedPath).toBe('Old/page--55555555.md');
  });

  it('MOVEでないパスはローカルファイルがあっても変更しない', async () => {
    const planned = path('create-page', 'New/Page.md');
    const result = await allocateOutputPaths({
      paths: [planned],
      existingById: new Map(),
      managedRoot,
      exists: existingPaths('New/Page.md'),
    });

    expect(result).toEqual({ paths: [planned], warnings: [] });
  });
});
