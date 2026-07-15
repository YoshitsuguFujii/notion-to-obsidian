import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileSystem } from '../src/filesystem/index.js';
import {
  assertNoSymlinkEscape,
  joinManagedPath,
  sanitizePathSegment,
} from '../src/filesystem/safe-path.js';

describe('sanitizePathSegment', () => {
  it.each(['/\\:*?"<>|', '\u0000control\u001f', 'trailing. ', '.', '..'])(
    '危険な名前 %j を安全な segment にする',
    (title) => {
      const segment = sanitizePathSegment(title, 'a1b2c3d4-rest');

      expect(segment).not.toMatch(/[\\/:*?"<>|]/u);
      expect(
        Array.from(segment).every(
          (character) => (character.codePointAt(0) ?? 0) >= 32,
        ),
      ).toBe(true);
      expect(segment).not.toMatch(/[. ]$/u);
      expect(segment).not.toBe('.');
      expect(segment).not.toBe('..');
      expect(segment.length).toBeGreaterThan(0);
    },
  );

  it.each([
    'CON',
    'prn',
    'AUX.txt',
    'nul',
    'COM1',
    'com9.md',
    'LPT1',
    'lpt9.txt',
  ])('Windows 予約名 %s を避ける', (title) => {
    expect(sanitizePathSegment(title, 'a1b2c3d4-rest')).not.toMatch(
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu,
    );
  });

  it('空タイトルを安定した ID 付き Untitled にする', () => {
    expect(sanitizePathSegment('   ', 'a1b2c3d4-rest')).toBe(
      'Untitled--a1b2c3d4',
    );
  });

  it('長いタイトルを上限内に切り詰め ID suffix を保持する', () => {
    const segment = sanitizePathSegment('あ'.repeat(300), 'a1b2c3d4-rest');

    expect(Array.from(segment)).toHaveLength(200);
    expect(segment).toMatch(/--a1b2c3d4$/u);
  });

  it('Unicode を NFC に正規化し絵文字を維持する', () => {
    expect(sanitizePathSegment('Cafe\u0301 📝', 'id')).toBe('Café 📝');
  });
});

describe('joinManagedPath', () => {
  it('managed root 配下の相対パスを絶対パスへ解決する', () => {
    expect(joinManagedPath('/vault/managed', 'Parent', 'Page.md')).toBe(
      resolve('/vault/managed/Parent/Page.md'),
    );
  });

  it.each(['../../etc/passwd', '/etc/passwd', '../managed2/file.md'])(
    'managed root 外へ出る入力 %s を拒否する',
    (path) => {
      expect(() => joinManagedPath('/vault/managed', path)).toThrow(/managed/i);
    },
  );
});

describe('assertNoSymlinkEscape', () => {
  it('対象までの ancestor に symlink があれば拒否する', async () => {
    const fileSystem = {
      isSymbolicLink: vi.fn((path: string) =>
        Promise.resolve(path === '/vault/managed/link'),
      ),
    } as unknown as FileSystem;

    await expect(
      assertNoSymlinkEscape(
        fileSystem,
        '/vault/managed',
        '/vault/managed/link/Page.md',
      ),
    ).rejects.toThrow(/symbolic link/i);
  });

  it('symlink の無い managed root 配下を許可する', async () => {
    const fileSystem = {
      isSymbolicLink: vi.fn().mockResolvedValue(false),
    } as unknown as FileSystem;

    await expect(
      assertNoSymlinkEscape(
        fileSystem,
        '/vault/managed',
        '/vault/managed/Parent/Page.md',
      ),
    ).resolves.toBeUndefined();
  });
});
