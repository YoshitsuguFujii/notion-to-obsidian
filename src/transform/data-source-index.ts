import { stringify } from 'yaml';

interface DataSourceSchemaProperty {
  name: string;
  type: string;
}

interface DataSourceIndexRow {
  title: string;
  path: string;
}

interface DataSourceIndexInput {
  name: string;
  notionUrl: string;
  dataSourceId: string;
  schema: readonly DataSourceSchemaProperty[];
  rows: readonly DataSourceIndexRow[];
  syncedAt: string;
  notionId?: string;
}

function inline(value: string): string {
  return value
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function tableCell(value: string): string {
  return inline(value).replaceAll('|', '\\|');
}

function wikiPath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/\.md$/iu, '')
    .replaceAll(']', '\\]');
}

function wikiAlias(value: string): string {
  return inline(value).replaceAll('|', '\\|').replaceAll(']', '\\]');
}

export function createDataSourceIndex(input: DataSourceIndexInput): string {
  const metadata = {
    managed_by: 'notion-to-obsidian',
    ...(input.notionId ? { notion_id: input.notionId } : {}),
    notion_data_source_id: input.dataSourceId,
    notion_url: input.notionUrl,
    synced_at: input.syncedAt,
  };
  const schemaRows = input.schema.map(
    ({ name, type }) => `| ${tableCell(name)} | ${tableCell(type)} |`,
  );
  const rowLinks = input.rows.map(
    ({ title, path }) => `- [[${wikiPath(path)}|${wikiAlias(title)}]]`,
  );
  return [
    '---',
    stringify(metadata, { lineWidth: 0 }).trimEnd(),
    '---',
    '',
    `# ${inline(input.name)}`,
    '',
    '## Schema',
    '',
    '| Property | Type |',
    '| --- | --- |',
    ...schemaRows,
    '',
    '## Rows',
    '',
    ...rowLinks,
    '',
  ].join('\n');
}
