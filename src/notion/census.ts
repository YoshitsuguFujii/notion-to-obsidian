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
  type:
    | 'root_unavailable'
    | 'child_list_incomplete'
    | 'search_missed_resource'
    | 'search_incomplete'
    | 'database_retrieve_failed'
    | 'multiple_data_sources';
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
type RootReachability = 'inside' | 'outside' | 'unknown';

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
    parentType: 'workspace',
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
  return {
    notionId,
    objectType: type === 'child_page' ? 'page' : 'database',
    title: string(child?.title) ?? '',
    ...parent(block.parent),
    rootId,
    lastEditedTime: string(block.last_edited_time) ?? '',
    inTrash: block.in_trash === true || block.archived === true,
    url: string(block.url) ?? '',
  };
}

function dataSourceIds(value: unknown): string[] {
  const dataSources = record(value)?.data_sources;
  if (!Array.isArray(dataSources)) return [];
  return dataSources.flatMap((dataSource) => {
    const id = string(record(dataSource)?.id);
    return id ? [id] : [];
  });
}

async function reachesRoot(
  client: NotionClient,
  candidateId: string,
  rootId: string,
): Promise<RootReachability> {
  const visited = new Set<string>();
  let currentId = candidateId;
  try {
    while (!visited.has(currentId)) {
      if (currentId === rootId) return 'inside';
      visited.add(currentId);
      const page = record(await client.retrievePage(currentId));
      const parentValue = parent(page?.parent);
      if (!parentValue.parentId) return 'outside';
      currentId = parentValue.parentId;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function searchForMissedResources(
  client: NotionClient,
  rootId: string,
  discovered: ReadonlySet<string>,
): Promise<{ warnings: CensusWarning[]; searchComplete: boolean }> {
  try {
    const candidates = await fetchAllPages<unknown>((cursor) =>
      client.search(cursor),
    );
    const warnings: CensusWarning[] = [];
    let searchComplete = true;
    for (const candidate of candidates) {
      const candidateRecord = record(candidate);
      const candidateId = string(candidateRecord?.id);
      if (
        candidateRecord?.object !== 'page' ||
        !candidateId ||
        discovered.has(candidateId)
      )
        continue;
      const reachability = await reachesRoot(client, candidateId, rootId);
      if (reachability === 'inside') {
        warnings.push({
          type: 'search_missed_resource',
          resourceId: candidateId,
          message:
            'Search found a root descendant missing from direct traversal',
        });
      } else if (reachability === 'unknown') {
        searchComplete = false;
      }
    }
    return { warnings, searchComplete };
  } catch {
    return {
      warnings: [
        {
          type: 'search_incomplete',
          resourceId: rootId,
          message: 'Search did not reach its final page',
        },
      ],
      searchComplete: false,
    };
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
  const visited = new Set<string>();

  const addResource = async (value: unknown): Promise<boolean> => {
    let resource = childResource(value, rootId);
    if (!resource) return false;
    if (discovered.has(resource.notionId)) return true;
    discovered.add(resource.notionId);
    if (resource.objectType === 'database') {
      try {
        const ids = dataSourceIds(
          await client.retrieveDatabase(resource.notionId),
        );
        const dataSourceId = ids[0];
        if (dataSourceId) resource = { ...resource, dataSourceId };
        if (ids.length > 1) {
          warnings.push({
            type: 'multiple_data_sources',
            resourceId: resource.notionId,
            message:
              'Database has multiple data sources; the first was selected',
          });
        }
      } catch {
        complete = false;
        warnings.push({
          type: 'database_retrieve_failed',
          resourceId: resource.notionId,
          message: 'Database metadata could not be retrieved',
        });
      }
    }
    resources.push(resource);
    queue.push(resource.notionId);
    return true;
  };

  const visitBlocks = async (blocks: readonly unknown[]): Promise<void> => {
    for (const blockValue of blocks) {
      if (await addResource(blockValue)) continue;
      const block = record(blockValue);
      const blockId = string(block?.id);
      if (block?.has_children !== true || !blockId || visited.has(blockId))
        continue;
      visited.add(blockId);
      try {
        const children = await fetchAllPages<unknown>((cursor) =>
          client.listBlockChildren(blockId, cursor),
        );
        await visitBlocks(children);
      } catch {
        complete = false;
        warnings.push({
          type: 'child_list_incomplete',
          resourceId: blockId,
          message: 'Child traversal did not reach its final page',
        });
      }
    }
  };

  while (queueIndex < queue.length) {
    const parentId = queue[queueIndex];
    queueIndex += 1;
    if (!parentId) continue;
    try {
      const children = await fetchAllPages<unknown>((cursor) =>
        client.listBlockChildren(parentId, cursor),
      );
      await visitBlocks(children);
    } catch {
      complete = false;
      warnings.push({
        type: 'child_list_incomplete',
        resourceId: parentId,
        message: 'Child traversal did not reach its final page',
      });
    }
  }

  const searchResult = await searchForMissedResources(
    client,
    rootId,
    discovered,
  );
  warnings.push(...searchResult.warnings);
  if (!searchResult.searchComplete || searchResult.warnings.length > 0)
    complete = false;
  return {
    rootId,
    status: complete ? 'complete' : 'partial',
    deletionAllowed: complete,
    resources,
    warnings,
  };
}
