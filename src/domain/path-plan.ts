import { posix } from 'node:path';
import { DomainError } from '../errors.js';
import {
  MAX_PATH_SEGMENT_CHARACTERS,
  sanitizePathSegment,
} from '../filesystem/safe-path.js';
import type { CensusResource } from '../notion/census.js';

export interface PlannedResourcePath {
  notionId: string;
  expectedPath: string;
  resolvedFilename: string;
}

interface PathPlanOptions {
  previousResolvedFilenames?: ReadonlyMap<string, string>;
}

interface Candidate {
  resource: CensusResource;
  base: string;
}

function shortId(notionId: string): string {
  return notionId.replaceAll('-', '').slice(0, 8) || 'unknown';
}

function collisionFilename(base: string, notionId: string): string {
  const suffix = `--${shortId(notionId)}`;
  const available = MAX_PATH_SEGMENT_CHARACTERS - Array.from(suffix).length;
  return `${Array.from(base).slice(0, available).join('')}${suffix}`;
}

function collisionKey(candidate: Candidate): string {
  return `${candidate.resource.parentId ?? '<root>'}\0${candidate.base.toLocaleLowerCase('en-US')}`;
}

function resolveFilenames(
  resources: readonly CensusResource[],
  previous: ReadonlyMap<string, string>,
): Map<string, string> {
  const groups = new Map<string, Candidate[]>();
  for (const resource of resources) {
    const candidate = {
      resource,
      base: sanitizePathSegment(resource.title, resource.notionId),
    };
    const key = collisionKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  const resolved = new Map<string, string>();
  for (const candidates of groups.values()) {
    const sorted = [...candidates].sort((left, right) =>
      left.resource.notionId.localeCompare(right.resource.notionId),
    );
    const used = new Set<string>();
    for (const candidate of sorted.filter(({ resource }) =>
      previous.has(resource.notionId),
    )) {
      const stored = previous.get(candidate.resource.notionId);
      if (!stored) continue;
      const safeStored = sanitizePathSegment(
        stored,
        candidate.resource.notionId,
      );
      if (
        safeStored !== candidate.base &&
        !safeStored.startsWith(`${candidate.base}--`)
      )
        continue;
      const key = safeStored.toLocaleLowerCase('en-US');
      if (used.has(key)) continue;
      resolved.set(candidate.resource.notionId, safeStored);
      used.add(key);
    }
    for (const candidate of sorted) {
      if (resolved.has(candidate.resource.notionId)) continue;
      const baseKey = candidate.base.toLocaleLowerCase('en-US');
      const filename = used.has(baseKey)
        ? collisionFilename(candidate.base, candidate.resource.notionId)
        : candidate.base;
      resolved.set(candidate.resource.notionId, filename);
      used.add(filename.toLocaleLowerCase('en-US'));
    }
  }
  return resolved;
}

export function planResourcePaths(
  resources: readonly CensusResource[],
  options: PathPlanOptions = {},
): PlannedResourcePath[] {
  const byId = new Map(
    resources.map((resource) => [resource.notionId, resource]),
  );
  for (const resource of resources) {
    if (resource.parentId && !byId.has(resource.parentId)) {
      throw new DomainError(
        'validation',
        `Resource parent is not in census: ${resource.parentId}`,
      );
    }
  }
  const resolved = resolveFilenames(
    resources,
    options.previousResolvedFilenames ?? new Map(),
  );
  const expectedPaths = new Map<string, string>();
  const visiting = new Set<string>();
  const buildPath = (notionId: string): string => {
    const cached = expectedPaths.get(notionId);
    if (cached) return cached;
    if (visiting.has(notionId)) {
      throw new DomainError(
        'validation',
        'Resource parent hierarchy is cyclic',
      );
    }
    visiting.add(notionId);
    const resource = byId.get(notionId);
    const filename = resolved.get(notionId);
    if (!resource || !filename) {
      throw new DomainError(
        'validation',
        `Resource path cannot be planned: ${notionId}`,
      );
    }
    const path = resource.parentId
      ? posix.join(
          buildPath(resource.parentId).replace(/\.md$/u, ''),
          `${filename}.md`,
        )
      : `${filename}.md`;
    visiting.delete(notionId);
    expectedPaths.set(notionId, path);
    return path;
  };

  return [...resources]
    .map((resource) => ({
      notionId: resource.notionId,
      expectedPath: buildPath(resource.notionId),
      resolvedFilename: resolved.get(resource.notionId) ?? '',
    }))
    .sort((left, right) =>
      left.expectedPath.localeCompare(right.expectedPath, 'en'),
    );
}
