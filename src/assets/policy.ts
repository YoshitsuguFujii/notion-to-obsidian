export interface AssetPolicy {
  downloadExternalAssets: boolean;
}

export const defaultAssetPolicy: Readonly<AssetPolicy> = Object.freeze({
  downloadExternalAssets: false,
});

export function shouldDownloadAsset(
  source: 'notion' | 'external',
  policy: Readonly<AssetPolicy>,
): boolean {
  return source === 'notion' || policy.downloadExternalAssets;
}
