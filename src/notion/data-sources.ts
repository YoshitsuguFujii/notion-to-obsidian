import { DomainError } from '../errors.js';
import type { CensusResource } from './census.js';
import { fetchAllPages } from './pagination.js';
import type { NotionClient } from './types.js';

export interface DataSourceRow extends Record<string, unknown> {
  object: 'page';
  id: string;
}

function isDataSourceRow(value: unknown): value is DataSourceRow {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).object === 'page' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

export async function fetchDataSourceRows(
  client: Pick<NotionClient, 'queryDataSource'>,
  dataSourceId: string,
): Promise<DataSourceRow[]> {
  const rows = await fetchAllPages<unknown>((cursor) =>
    client.queryDataSource(dataSourceId, cursor),
  );
  if (!rows.every(isDataSourceRow)) {
    throw new DomainError(
      'validation',
      'Data Source query returned a non-page result',
    );
  }
  return rows;
}

export function deduplicateDataSourceIds(
  resources: readonly Pick<CensusResource, 'dataSourceId'>[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { dataSourceId } of resources) {
    if (!dataSourceId || seen.has(dataSourceId)) continue;
    seen.add(dataSourceId);
    ids.push(dataSourceId);
  }
  return ids;
}
