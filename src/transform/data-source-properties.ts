import { normalizeNotionId } from './obsidian-links.js';
import { replaceRetainedSignedUrls } from './signed-asset-urls.js';
import { stableReferenceUrl } from './stable-url.js';

type UnknownRecord = Record<string, unknown>;

export type DataSourcePropertyValue = unknown;

interface ConvertedValue {
  value: unknown;
  replacedCount: number;
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((part) => {
      const item = record(part);
      if (typeof item?.plain_text === 'string') return item.plain_text;
      const content = record(item?.text)?.content;
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

function named(value: unknown): string | null {
  if (value === null) return null;
  const name = record(value)?.name;
  return typeof name === 'string' ? name : null;
}

function user(value: unknown): { id: string; name?: string } | undefined {
  const item = record(value);
  if (typeof item?.id !== 'string') return undefined;
  return {
    id: item.id,
    ...(typeof item.name === 'string' ? { name: item.name } : {}),
  };
}

function date(value: unknown): unknown {
  if (value === null) return null;
  const item = record(value);
  if (typeof item?.start !== 'string') return value;
  const end = typeof item.end === 'string' ? item.end : undefined;
  const timeZone =
    typeof item.time_zone === 'string' ? item.time_zone : undefined;
  if (!end && !timeZone) return item.start;
  return {
    start: item.start,
    ...(end ? { end } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

function file(value: unknown): { name: string; url: string } | undefined {
  const item = record(value);
  if (!item || typeof item.name !== 'string' || typeof item.type !== 'string')
    return undefined;
  const url = record(item[item.type])?.url;
  return typeof url === 'string' ? { name: item.name, url } : undefined;
}

function typedValue(value: unknown): unknown {
  const item = record(value);
  if (!item || typeof item.type !== 'string') return value;
  switch (item.type) {
    case 'string':
      return item.string ?? null;
    case 'number':
      return item.number ?? null;
    case 'boolean':
      return item.boolean ?? null;
    case 'date':
      return date(item.date);
    case 'array':
      return Array.isArray(item.array)
        ? item.array.map(convertDataSourceProperty)
        : [];
    default:
      return item;
  }
}

function relation(value: unknown): Array<{ id: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = record(entry)?.id;
    return typeof id === 'string' ? [{ id }] : [];
  });
}

function fallback(type: string, raw: unknown): unknown {
  return { type, raw };
}

function replaceSignedUrlText(value: string): ConvertedValue {
  const replaced = replaceRetainedSignedUrls(value);
  return { value: replaced.markdown, replacedCount: replaced.replacedCount };
}

function stabilizeRawValue(value: unknown): ConvertedValue {
  if (typeof value === 'string') return replaceSignedUrlText(value);
  if (Array.isArray(value)) {
    const entries = value.map(stabilizeRawValue);
    return {
      value: entries.map((entry) => entry.value),
      replacedCount: entries.reduce(
        (count, entry) => count + entry.replacedCount,
        0,
      ),
    };
  }
  const item = record(value);
  if (!item) return { value, replacedCount: 0 };

  const external = record(item.external);
  if (item.type === 'external' && typeof external?.url === 'string') {
    let replacedCount = 0;
    const stabilized = Object.fromEntries(
      Object.entries(item).map(([key, entry]) => {
        if (key !== 'external') {
          const transformed = stabilizeRawValue(entry);
          replacedCount += transformed.replacedCount;
          return [key, transformed.value];
        }
        const externalFields = Object.fromEntries(
          Object.entries(external).map(([externalKey, externalValue]) => {
            if (externalKey === 'url') return [externalKey, externalValue];
            const transformed = stabilizeRawValue(externalValue);
            replacedCount += transformed.replacedCount;
            return [externalKey, transformed.value];
          }),
        );
        return [key, externalFields];
      }),
    );
    return { value: stabilized, replacedCount };
  }

  const notionFile = record(item.file);
  if (item.type === 'file' && typeof notionFile?.url === 'string') {
    let replacedCount = 0;
    const stabilized = Object.fromEntries(
      Object.entries(item).map(([key, entry]) => {
        if (key !== 'file') {
          const transformed = stabilizeRawValue(entry);
          replacedCount += transformed.replacedCount;
          return [key, transformed.value];
        }
        const fileFields = Object.fromEntries(
          Object.entries(notionFile).map(([fileKey, fileValue]) => {
            if (fileKey !== 'url') {
              const transformed = stabilizeRawValue(fileValue);
              replacedCount += transformed.replacedCount;
              return [fileKey, transformed.value];
            }
            const stableUrl = stableReferenceUrl(
              notionFile.url as string,
              'notion',
            );
            if (stableUrl !== notionFile.url) replacedCount += 1;
            return [fileKey, stableUrl];
          }),
        );
        return [key, fileFields];
      }),
    );
    return { value: stabilized, replacedCount };
  }

  let replacedCount = 0;
  const stabilized = Object.fromEntries(
    Object.entries(item).map(([key, entry]) => {
      const transformed = stabilizeRawValue(entry);
      replacedCount += transformed.replacedCount;
      return [key, transformed.value];
    }),
  );
  return { value: stabilized, replacedCount };
}

function convertFiles(property: UnknownRecord): ConvertedValue {
  if (!Array.isArray(property.files)) {
    return stabilizeRawValue(fallback('files', property));
  }
  const files: Array<{ name: string; url: string }> = [];
  let replacedCount = 0;
  for (const entry of property.files) {
    const item = record(entry);
    if (!item || typeof item.name !== 'string' || typeof item.type !== 'string')
      continue;
    const source = record(item[item.type]);
    if (typeof source?.url !== 'string') continue;
    if (item.type === 'external') {
      const name = replaceSignedUrlText(item.name);
      replacedCount += name.replacedCount;
      files.push({ name: name.value as string, url: source.url });
      continue;
    }
    const name = replaceSignedUrlText(item.name);
    const stableNotionUrl =
      item.type === 'file'
        ? stableReferenceUrl(source.url, 'notion')
        : undefined;
    const stabilizedUrl =
      stableNotionUrl === undefined
        ? replaceSignedUrlText(source.url)
        : {
            value: stableNotionUrl,
            replacedCount: stableNotionUrl === source.url ? 0 : 1,
          };
    replacedCount += name.replacedCount;
    replacedCount += stabilizedUrl.replacedCount;
    files.push({
      name: name.value as string,
      url: stabilizedUrl.value as string,
    });
  }
  return { value: files, replacedCount };
}

function convertDataSourcePropertyResult(property: unknown): ConvertedValue {
  const item = record(property);
  const type = item?.type;
  if (!item || typeof type !== 'string') {
    return stabilizeRawValue(fallback('unknown', property));
  }
  if (type === 'files') return convertFiles(item);
  if (type === 'formula' || type === 'rollup') {
    const value = stabilizeRawValue(typedValue(item[type]));
    const raw = stabilizeRawValue(item[type]);
    return {
      value: { value: value.value, raw: raw.value },
      replacedCount: value.replacedCount + raw.replacedCount,
    };
  }
  return stabilizeRawValue(convertDataSourceProperty(property));
}

export function convertDataSourceProperty(
  property: unknown,
): DataSourcePropertyValue {
  const item = record(property);
  const type = item?.type;
  if (!item || typeof type !== 'string') return fallback('unknown', property);
  switch (type) {
    case 'title':
    case 'rich_text': {
      const value = text(item[type]);
      return value ?? fallback(type, property);
    }
    case 'number':
      return typeof item.number === 'number' || item.number === null
        ? item.number
        : fallback(type, property);
    case 'select':
    case 'status':
      return named(item[type]);
    case 'multi_select':
      return Array.isArray(item.multi_select)
        ? item.multi_select.flatMap((entry) => {
            const name = named(entry);
            return name === null ? [] : [name];
          })
        : fallback(type, property);
    case 'date':
      return date(item.date);
    case 'people':
      return Array.isArray(item.people)
        ? item.people.flatMap((entry) => {
            const value = user(entry);
            return value ? [value] : [];
          })
        : fallback(type, property);
    case 'files':
      return Array.isArray(item.files)
        ? item.files.flatMap((entry) => {
            const value = file(entry);
            return value ? [value] : [];
          })
        : fallback(type, property);
    case 'checkbox':
      return typeof item.checkbox === 'boolean'
        ? item.checkbox
        : fallback(type, property);
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return typeof item[type] === 'string' || item[type] === null
        ? item[type]
        : fallback(type, property);
    case 'formula':
    case 'rollup':
      return { value: typedValue(item[type]), raw: item[type] };
    case 'relation': {
      if (!Array.isArray(item.relation)) return fallback(type, property);
      const raw = item.relation;
      const relations = relation(raw);
      return {
        value: relations.map(({ id }) => id),
        raw,
        ...(typeof item.has_more === 'boolean'
          ? { hasMore: item.has_more }
          : {}),
      };
    }
    case 'created_by':
    case 'last_edited_by':
      return user(item[type]) ?? fallback(type, property);
    case 'unique_id': {
      const uniqueId = record(item.unique_id);
      if (!uniqueId || typeof uniqueId.number !== 'number')
        return fallback(type, property);
      const prefix =
        typeof uniqueId.prefix === 'string' && uniqueId.prefix.length > 0
          ? `${uniqueId.prefix}-`
          : '';
      return `${prefix}${uniqueId.number}`;
    }
    default:
      return fallback(type, property);
  }
}

function normalizedPaths(
  idToPath: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const [id, path] of idToPath) {
    const normalized = normalizeNotionId(id);
    if (normalized) paths.set(normalized, path);
  }
  return paths;
}

function wikiLink(path: string): string {
  const normalized = path
    .replaceAll('\\', '/')
    .replace(/\.md$/iu, '')
    .replaceAll(']', '\\]');
  return `[[${normalized}]]`;
}

export function resolveRelationProperty(
  property: unknown,
  idToPath: ReadonlyMap<string, string>,
): {
  value: string[];
  raw: unknown[];
  hasMore?: boolean;
} {
  const item = record(property);
  const raw = Array.isArray(item?.relation) ? item.relation : [];
  const relations = relation(raw);
  const paths = normalizedPaths(idToPath);
  return {
    value: relations.map(({ id }) => {
      const normalized = normalizeNotionId(id);
      const path = normalized ? paths.get(normalized) : undefined;
      return path ? wikiLink(path) : id;
    }),
    raw,
    ...(typeof item?.has_more === 'boolean' ? { hasMore: item.has_more } : {}),
  };
}

export function convertDataSourceProperties(
  properties: Readonly<Record<string, unknown>>,
  idToPath: ReadonlyMap<string, string>,
): {
  properties: Record<string, unknown>;
  replacedCount: number;
} {
  let replacedCount = 0;
  const converted = Object.fromEntries(
    Object.entries(properties).map(([name, property]) => {
      const item = record(property);
      const result =
        item?.type === 'relation'
          ? stabilizeRawValue(resolveRelationProperty(property, idToPath))
          : convertDataSourcePropertyResult(property);
      replacedCount += result.replacedCount;
      return [name, result.value];
    }),
  );
  return { properties: converted, replacedCount };
}
