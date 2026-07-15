import { InfraError } from '../errors.js';

export interface CursorPage<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

function isCursorPage<T>(value: unknown): value is CursorPage<T> {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return (
    Array.isArray(page.results) &&
    typeof page.has_more === 'boolean' &&
    (typeof page.next_cursor === 'string' || page.next_cursor === null)
  );
}

export async function fetchAllPages<T>(
  fetchPage: (cursor?: string) => Promise<unknown>,
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined | null;
  while (cursor !== null) {
    const response = await fetchPage(cursor);
    if (!isCursorPage<T>(response)) {
      throw new InfraError('validation', 'Invalid cursor page response');
    }
    results.push(...response.results);
    if (!response.has_more) {
      cursor = null;
      continue;
    }
    if (!response.next_cursor) {
      throw new InfraError(
        'validation',
        'Cursor page has no continuation cursor',
      );
    }
    cursor = response.next_cursor;
  }
  return results;
}
