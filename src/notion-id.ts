const DASHED_NOTION_ID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const COMPACT_NOTION_ID_SOURCE = '[0-9a-f]{32}';

const dashedNotionIdPattern = new RegExp(`^${DASHED_NOTION_ID_SOURCE}$`, 'iu');
const compactNotionIdPattern = new RegExp(
  `^${COMPACT_NOTION_ID_SOURCE}$`,
  'iu',
);
const notionIdSuffixPattern = new RegExp(
  `(?:${COMPACT_NOTION_ID_SOURCE}|${DASHED_NOTION_ID_SOURCE})$`,
  'iu',
);

export function isDashedNotionId(value: string): boolean {
  return dashedNotionIdPattern.test(value);
}

export function normalizeNotionId(value: string): string | undefined {
  if (!compactNotionIdPattern.test(value) && !isDashedNotionId(value)) {
    return undefined;
  }
  return value.replaceAll('-', '').toLowerCase();
}

export function extractNotionIdFromPathSegment(
  value: string,
): string | undefined {
  const match = notionIdSuffixPattern.exec(value);
  return match?.[0] ? normalizeNotionId(match[0]) : undefined;
}
