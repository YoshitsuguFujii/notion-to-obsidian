export interface AssetMetadata {
  url?: string;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  contentHash?: string;
  blockLastEditedTime?: string;
}

const metadataKeys = [
  'etag',
  'lastModified',
  'contentLength',
  'contentHash',
  'blockLastEditedTime',
] as const satisfies ReadonlyArray<keyof AssetMetadata>;

export function shouldRedownload(
  previous: AssetMetadata | undefined,
  current: AssetMetadata,
): boolean {
  if (!previous) return true;
  let comparable = false;
  for (const key of metadataKeys) {
    const previousValue = previous[key];
    const currentValue = current[key];
    if (previousValue === undefined || currentValue === undefined) continue;
    comparable = true;
    if (previousValue !== currentValue) return true;
  }
  return !comparable;
}
