import type { NotionClient } from './types.js';
import { fetchAllPages } from './pagination.js';

export type CensusObjectType = 'page' | 'database';
export type ParentType = 'page' | 'database' | 'workspace' | 'unknown';

export interface CensusResource {
  notionId: string;
  objectType: CensusObjectType;
  title: string;
  parentId?: string;
  parentType: ParentType;
  rootId: string;
  lastEditedTime: string;
  inTrash: boolean;
  url: string;
  dataSourceId?: string;
  expectedPath?: string;
}

export interface CensusWarning {
  type: 'root_unavailable' | 'child_list_incomplete' | 'search_missed_resource';
  resourceId: string;
  message: string;
}

export interface RootCensus {
  rootId: string;
  status: 'complete' | 'partial';
  deletionAllowed: boolean;
  resources: CensusResource[];
  warnings: CensusWarning[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? (value as UnknownRecord)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parent(value: unknown): { parentType: ParentType; parentId?: string } {
  const parentValue = record(value);
  const type = string(parentValue?.type);
  if (type === 'page_id') {
    const parentId = string(parentValue?.page_id);
    return { parentType: 'page', ...(parentId ? { parentId } : {}) };
  }
  if (type === 'database_id') {
    const parentId = string(parentValue?.database_id);
    return { parentType: 'database', ...(parentId ? { parentId } : {}) };
  }
  if (type === 'workspace') return { parentType: 'workspace' };
  return { parentType: 'unknown' };
}

function pageTitle(value: UnknownRecord): string {
  const properties = record(value.properties);
  if (!properties) return '';
  for (const property of Object.values(properties)) {
    const candidate = record(property);
    if (candidate?.type !== 'title' || !Array.isArray(candidate.title))
      continue;
    return candidate.title
      .map((part) => string(record(part)?.plain_text) ?? '')
      .join('');
  }
  return '';
}

function rootResource(
  value: unknown,
  rootId: string,
): CensusResource | undefined {
  const page = record(value);
  if (!page || page.object !== 'page' || string(page.id) !== rootId)
    return undefined;
  return {
    notionId: rootId,
    objectType: 'page',
    title: pageTitle(page),
    ...parent(page.parent),
    rootId,
    lastEditedTime: string(page.last_edited_time) ?? '',
    inTrash: page.in_trash === true || page.archived === true,
    url: string(page.url) ?? '',
  };
}

function childResource(
  value: unknown,
  rootId: string,
): CensusResource | undefined {
  const block = record(value);
  const notionId = string(block?.id);
  const type = string(block?.type);
  if (
    !block ||
    !notionId ||
    (type !== 'child_page' && type !== 'child_database')
  )
    return undefined;
  const child = record(block[type]);
  const dataSources = record(block.child_database)?.data_sources;
  const firstDataSource = Array.isArray(dataSources)
    ? record(dataSources[0])
    : undefined;
  const dataSourceId = string(firstDataSource?.id);
  return {
    notionId,
    objectType: type === 'child_page' ? 'page' : 'database',
    title: string(child?.title) ?? '',
    ...parent(block.parent),
    rootId,
    lastEditedTime: string(block.last_edited_time) ?? '',
    inTrash: block.in_trash === true || block.archived === true,
    url: string(block.url) ?? '',
    ...(dataSourceId ? { dataSourceId } : {}),
  };
}

async function reachesRoot(
  client: NotionClient,
  candidateId: string,
  rootId: string,
): Promise<boolean | undefined> {
  const visited = new Set<string>();
  let currentId = candidateId;
  try {
    while (!visited.has(currentId)) {
      if (currentId === rootId) return true;
      visited.add(currentId);
      const page = record(await client.retrievePage(currentId));
      const parentValue = parent(page?.parent);
      if (!parentValue.parentId) return false;
      currentId = parentValue.parentId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function searchForMissedResources(
  client: NotionClient,
  rootId: string,
  discovered: ReadonlySet<string>,
): Promise<CensusWarning[]> {
  try {
    const candidates = await fetchAllPages<unknown>((cursor) =>
      client.search(cursor),
    );
    const warnings: CensusWarning[] = [];
    for (const candidate of candidates) {
      const candidateRecord = record(candidate);
      const candidateId = string(candidateRecord?.id);
      if (
        candidateRecord?.object !== 'page' ||
        !candidateId ||
        discovered.has(candidateId)
      )
        continue;
      if ((await reachesRoot(client, candidateId, rootId)) === true) {
        warnings.push({
          type: 'search_missed_resource',
          resourceId: candidateId,
          message:
            'Search found a root descendant missing from direct traversal',
        });
      }
    }
    return warnings;
  } catch {
    return [];
  }
}

export async function censusRoot(
  client: NotionClient,
  rootId: string,
): Promise<RootCensus> {
  const warnings: CensusWarning[] = [];
  let root: CensusResource | undefined;
  try {
    root = rootResource(await client.retrievePage(rootId), rootId);
  } catch {
    // A failed root retrieval cannot establish any safe deletion boundary.
  }
  if (!root) {
    warnings.push({
      type: 'root_unavailable',
      resourceId: rootId,
      message: 'Root page could not be retrieved',
    });
    return {
      rootId,
      status: 'partial',
      deletionAllowed: false,
      resources: [],
      warnings,
    };
  }

  const resources = [root];
  const discovered = new Set([rootId]);
  const queue = [rootId];
  let queueIndex = 0;
  let complete = true;
  while (queueIndex < queue.length) {
    const parentId = queue[queueIndex];
    queueIndex += 1;
    if (!parentId) continue;
    try {
      const children = await fetchAllPages<unknown>((cursor) =>
        client.listBlockChildren(parentId, cursor),
      );
      for (const child of children) {
        const resource = childResource(child, rootId);
        if (!resource || discovered.has(resource.notionId)) continue;
        discovered.add(resource.notionId);
        resources.push(resource);
        queue.push(resource.notionId);
      }
    } catch {
      complete = false;
      warnings.push({
        type: 'child_list_incomplete',
        resourceId: parentId,
        message: 'Child traversal did not reach its final page',
      });
    }
  }

  const searchWarnings = await searchForMissedResources(
    client,
    rootId,
    discovered,
  );
  warnings.push(...searchWarnings);
  if (searchWarnings.length > 0) complete = false;
  return {
    rootId,
    status: complete ? 'complete' : 'partial',
    deletionAllowed: complete,
    resources,
    warnings,
  };
}
