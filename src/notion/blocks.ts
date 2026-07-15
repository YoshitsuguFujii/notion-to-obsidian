import { fetchAllPages } from './pagination.js';
import type { NotionClient } from './types.js';

export interface BlockNode {
  block: Record<string, unknown>;
  children: BlockNode[];
}

function asBlock(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function retrieveBlockTree(
  client: Pick<NotionClient, 'listBlockChildren'>,
  parentId: string,
): Promise<BlockNode[]> {
  const expanded = new Set<string>();
  const retrieveChildren = async (id: string): Promise<BlockNode[]> => {
    const values = await fetchAllPages<unknown>((cursor) =>
      client.listBlockChildren(id, cursor),
    );
    const nodes: BlockNode[] = [];
    for (const value of values) {
      const block = asBlock(value);
      if (!block) continue;
      const blockId = typeof block.id === 'string' ? block.id : undefined;
      let children: BlockNode[] = [];
      if (blockId && block.has_children === true && !expanded.has(blockId)) {
        expanded.add(blockId);
        children = await retrieveChildren(blockId);
      }
      nodes.push({ block, children });
    }
    return nodes;
  };
  return retrieveChildren(parentId);
}
