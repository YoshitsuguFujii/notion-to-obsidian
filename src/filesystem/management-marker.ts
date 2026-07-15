import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface StoredManagementRecord {
  notionId: string;
  localPath?: string;
}

interface MarkerInput {
  managedRoot: string;
  filePath: string;
  content: string;
  stored: StoredManagementRecord | undefined;
}

export interface ManagementMarkerResult {
  managed: boolean;
  notionId?: string;
  contentHash?: string;
}

function frontmatter(content: string): Record<string, unknown> | undefined {
  if (!content.startsWith('---\n')) return undefined;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return undefined;
  try {
    const value: unknown = parse(content.slice(4, end));
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function markdownBody(content: string): string | undefined {
  if (!content.startsWith('---\n')) return undefined;
  const end = content.indexOf('\n---\n', 4);
  return end < 0 ? undefined : content.slice(end + 5);
}

export function readManagementMarker(content: string):
  | {
      notionId: string;
      contentHash?: string;
    }
  | undefined {
  const metadata = frontmatter(content);
  const notionId = metadata?.notion_id;
  if (
    metadata?.managed_by !== 'notion-to-obsidian' ||
    typeof notionId !== 'string' ||
    !uuid.test(notionId)
  ) {
    return undefined;
  }
  const contentHash = metadata.content_hash;
  return {
    notionId,
    ...(typeof contentHash === 'string' ? { contentHash } : {}),
  };
}

function relativeManagedPath(
  managedRoot: string,
  filePath: string,
): string | undefined {
  const fromRoot = relative(resolve(managedRoot), resolve(filePath));
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return undefined;
  }
  return fromRoot.split(sep).join('/');
}

export function inspectManagementMarker(
  input: MarkerInput,
): ManagementMarkerResult {
  const localPath = relativeManagedPath(input.managedRoot, input.filePath);
  const marker = readManagementMarker(input.content);
  const notionId = marker?.notionId;
  if (
    !localPath ||
    !notionId ||
    !input.stored ||
    input.stored.notionId !== notionId ||
    input.stored.localPath !== localPath
  ) {
    return { managed: false };
  }
  return {
    managed: true,
    notionId,
    ...(marker.contentHash ? { contentHash: marker.contentHash } : {}),
  };
}
