import { stringify } from 'yaml';
import type { CensusObjectType } from '../notion/census.js';

export interface FrontmatterInput {
  notionId: string;
  notionUrl: string;
  notionRootId: string;
  notionParentId: string | null;
  notionObjectType: CensusObjectType;
  notionLastEditedTime: string;
  syncedAt: string;
  title: string;
  contentHash?: string;
  properties?: Readonly<Record<string, unknown>>;
}

export function createFrontmatter(input: FrontmatterInput): string {
  const metadata = {
    managed_by: 'notion-to-obsidian',
    notion_id: input.notionId,
    notion_url: input.notionUrl,
    notion_root_id: input.notionRootId,
    notion_parent_id: input.notionParentId,
    notion_object_type: input.notionObjectType,
    notion_last_edited_time: input.notionLastEditedTime,
    synced_at: input.syncedAt,
    title: input.title,
    ...(input.contentHash ? { content_hash: input.contentHash } : {}),
    ...(input.properties ? { notion_properties: input.properties } : {}),
  };
  return `---\n${stringify(metadata, { lineWidth: 0 })}---\n`;
}
