import { describe, expect, it } from 'vitest';
import {
  defaultAssetPolicy,
  shouldDownloadAsset,
} from '../src/assets/policy.js';

describe('asset download policy', () => {
  it('外部URL取得を既定で無効にする', () => {
    expect(defaultAssetPolicy).toEqual({ downloadExternalAssets: false });
    expect(shouldDownloadAsset('external', defaultAssetPolicy)).toBe(false);
  });

  it('Notion管理assetは既定で取得対象にする', () => {
    expect(shouldDownloadAsset('notion', defaultAssetPolicy)).toBe(true);
  });

  it('明示設定された場合だけ外部URLを取得対象にする', () => {
    expect(
      shouldDownloadAsset('external', { downloadExternalAssets: true }),
    ).toBe(true);
  });
});
