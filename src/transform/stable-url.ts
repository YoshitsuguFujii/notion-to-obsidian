export function stableReferenceUrl(
  remoteUrl: string,
  source: 'notion' | 'external',
): string {
  if (source === 'external') return remoteUrl;
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return remoteUrl;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return remoteUrl;
  }
}
