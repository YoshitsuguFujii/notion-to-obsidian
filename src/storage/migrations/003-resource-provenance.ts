export const version = 3;

// ADD COLUMN preserves the existing resources table instead of rebuilding it.
// 既存行は NULL のまま残る（provenance 未設定）。orchestrator 側は NULL を
// 「これまで一度も現在の設定・変換ロジックで生成されていない」として扱い、
// 次回同期で一度だけ安全に再生成する。
export const sql = `
ALTER TABLE resources ADD COLUMN generated_config_hash TEXT;
ALTER TABLE resources ADD COLUMN generated_transform_version TEXT;
ALTER TABLE resources ADD COLUMN generated_api_version TEXT;
`;
