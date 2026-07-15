export interface NotionClient {
  retrievePage(pageId: string): Promise<unknown>;
  retrieveDatabase(databaseId: string): Promise<unknown>;
  retrieveMarkdown(pageId: string): Promise<unknown>;
  listBlockChildren(blockId: string, cursor?: string): Promise<unknown>;
  queryDataSource(dataSourceId: string, cursor?: string): Promise<unknown>;
  search(cursor?: string): Promise<unknown>;
}
