import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DomainError } from '../errors.js';
import type { FileSystem } from './index.js';

const dangerousCharacters = new Set([
  '/',
  '\\',
  ':',
  '*',
  '?',
  '"',
  '<',
  '>',
  '|',
]);
const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
export const MAX_PATH_SEGMENT_CHARACTERS = 200;

function shortId(notionId: string): string {
  return notionId.replaceAll('-', '').slice(0, 8) || 'unknown';
}

function truncateWithId(value: string, notionId: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_PATH_SEGMENT_CHARACTERS) return value;
  const suffix = `--${shortId(notionId)}`;
  return `${characters
    .slice(0, MAX_PATH_SEGMENT_CHARACTERS - Array.from(suffix).length)
    .join('')}${suffix}`;
}

export function sanitizePathSegment(title: string, notionId: string): string {
  let segment = Array.from(title.normalize('NFC'))
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return dangerousCharacters.has(character) ||
        codePoint < 32 ||
        codePoint === 127
        ? '-'
        : character;
    })
    .join('')
    .trim()
    .replace(/[. ]+$/gu, '');
  if (segment === '.' || segment === '..') segment = '';
  if (!segment) return `Untitled--${shortId(notionId)}`;
  if (windowsReservedName.test(segment)) segment = `_${segment}`;
  return truncateWithId(segment, notionId);
}

function isWithinManagedRoot(managedRoot: string, target: string): boolean {
  const pathFromRoot = relative(managedRoot, target);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== '..' &&
      !isAbsolute(pathFromRoot))
  );
}

export function joinManagedPath(
  managedRoot: string,
  ...relativeSegments: string[]
): string {
  if (relativeSegments.some((segment) => isAbsolute(segment))) {
    throw new DomainError(
      'safety',
      'Absolute path is outside the managed root',
    );
  }
  const root = resolve(managedRoot);
  const target = resolve(root, ...relativeSegments);
  if (!isWithinManagedRoot(root, target)) {
    throw new DomainError('safety', 'Path escapes the managed root');
  }
  return target;
}

export async function assertNoSymlinkEscape(
  fileSystem: Pick<FileSystem, 'isSymbolicLink'>,
  managedRoot: string,
  targetPath: string,
): Promise<void> {
  const root = resolve(managedRoot);
  const target = resolve(targetPath);
  if (!isWithinManagedRoot(root, target)) {
    throw new DomainError('safety', 'Path escapes the managed root');
  }
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = resolve(current, part);
    if (await fileSystem.isSymbolicLink(current)) {
      throw new DomainError(
        'safety',
        `Symbolic link is not allowed: ${current}`,
      );
    }
  }
}
