# アーキテクチャ

## 目的とスコープ

Notion を唯一の正本とし、指定ルートページ配下のコンテンツを Obsidian Vault 内の管理対象ディレクトリへ **Markdown として一方向（Notion → Obsidian）にミラー**する読み取り専用 CLI。Notion API への書き込みは一切行わない。

## 全体フロー: Census → Plan → Apply

同期は 3 段階に明確に分離する。各段の責務を混ぜない。

```
┌─────────┐   ┌────────┐   ┌────────┐
│ Census  │──▶│  Plan  │──▶│ Apply  │
└─────────┘   └────────┘   └────────┘
 対象範囲の      全変更を       atomic な
 全メタデータ    事前計算＋      書き込み /
 を収集         安全検証        移動 / 退避
```

### Census（`src/notion/census.ts`）
- **ルートからの直接再帰探索を正本**とする。`blocks.children.list` で一般ブロックの子まで辿り、ネストした `child_page` / `child_database` を含む対象範囲の現在のページ集合と階層を毎回再構築する。指定ルートの外部親は同期境界に含めず、ルートを出力上の最上位として扱う。
- 親の `last_edited_time` が未更新でも子を必ず探索する（親未更新→子探索スキップは禁止）。
- Search API は **補完・診断・親グラフ照合のみ**。Search 結果だけを根拠に対象外判定や TRASH 判定をしない。Search が incomplete/完全性を保証できない場合、その結果を削除判断に使わない。
- ページネーション完走・ページID重複排除・循環/link による無限再帰防止・linked database の ID 重複排除。
- 各 root に `complete | partial` ステータスと `deletion_allowed`（partial または Search-incomplete では false）を付与する。
- 出力（census レコード）: `notion_id, object_type, title, parent_id/type, root_id, last_edited_time, in_trash, url, data_source_id, expected_path`。

### Plan（`src/sync/planner.ts`, `src/sync/output-path-allocator.ts`）
- アクション種別: `CREATE / UPDATE / MOVE / TRASH / DOWNLOAD_ASSET / REMOVE_ORPHAN_ASSET / UNCHANGED / WARNING / ERROR`。
- 出力パスの事前割り当て（`output-path-allocator.ts`）: MOVE 先がローカルの既存ファイルや計画内の別ページのパスと衝突する場合、Plan 段で決定論的な回避パス（`--短縮ID`）を確定する。確定パスは idToPath / WikiLink / structureHash / DB / 実ファイルへ一貫して使い、Apply 中にはパスを変更しない（Apply 時に移動先が埋まっていれば停止＝TOCTOU 防止）。回避は MOVE のみに適用し、CREATE/UPDATE の管理外衝突は下記の安全性検証で Apply を中止する。
- plan / dry-runでもmissing回数を進めた場合のTRASH予定を予測し、large trash安全弁をApply前と同じ条件で検証する。予測と検証はDB・ファイル・ディレクトリを変更しない。
- Apply 前に Plan 全体の安全性を検証し、異常時は Apply を中止する: managed 外へのパス / 同一出力パスへ複数ページ / root path 自体の削除 / 異常に大量の TRASH / census が partial / state DB と管理ファイルの重大な不整合 / Vault パス不在 / Vault root を managed に指定 / managed が `/` やホーム。
- 大量退避の安全弁: `maximum_trash_ratio` / `maximum_trash_count` 超過は `--allow-large-trash` 無しでは Apply しない。

### Apply（`src/sync/executor.ts`）
- Markdown・アセットは一時ファイルへ書き込み、成功後に**アトミックに置換**（同一ファイルシステム上の一時ファイル）。
- DB 更新は transaction。ファイル書き込みに失敗したページを「同期済み」と記録しない。DB だけ/ファイルだけ更新の片側更新を可能な限り防ぎ、クラッシュリカバリ可能にする。

## 境界の interface 化（テスト可能性）

外部境界をすべて interface 化し、ユニットテストがネットワーク・実 FS・実時刻・乱数に依存しないようにする。

- `NotionClient`（`src/notion/client.ts`）: 公式 SDK をラップ。ユニットテストはこの interface のモックを使い、SDK を直接呼ばない。
- `FileSystem`（`src/filesystem/`）: 読み書き・move・atomic write・symlink 判定。
- `HttpDownloader`（`src/assets/`）: アセット取得。SSRF 対策とストリーミング。
- `Clock` / `IdGenerator`: 時刻・ID をテストで固定可能に。
- `StateStore`（`src/storage/state-store.ts`）: 同期状態。実装は better-sqlite3 を storage 層に隔離（ADR-003）。

## 状態管理（SQLite / better-sqlite3）

- SQL とネイティブ依存は storage 層に閉じ込め、ドメイン層に SQL を漏らさない。
- スキーマにバージョンと migration 機構。`foreign_keys` ON、`busy_timeout` 設定、transaction 活用、接続 close 保証。
- 主要テーブル: `sync_runs` / `roots` / `resources` / `assets` / `warnings`（詳細は仕様 §19）。
- **CLI 全体の最終実行日時は `sync_runs` に保存**する（frontmatter には持たせない）。

## Frontmatter と idempotency

- 全管理 Markdown に frontmatter（`managed_by, notion_id, notion_url, notion_root_id, notion_parent_id, notion_object_type, notion_last_edited_time, synced_at, title` ほか）を正式 YAML シリアライザで付与。
- **`synced_at` は実際に CREATE/UPDATE した日時**。UNCHANGED のファイルでは `synced_at` を更新せず、content も mtime も変更しない。
- 差分判定は `last_edited_time` 単独に依存せず、content_hash / structure_hash / config_hash / transform_version / api_version / パス・衝突状況も見る。**同一入力の 2 回目同期は content も mtime も無変更**（idempotent）。

## Phase 2 / Phase 6 の責任分離

- **Phase 2**: Census の完全性・root ごとの `complete | partial`・`deletion_allowed` 判定まで。実際の削除系（missing 回数更新・grace runs・TRASH 計画・退避）は行わない。テストで「partial census から削除系アクションが生成可能な状態にならない」ことを確認する。
- **Phase 6**: missing 回数更新・grace runs・TRASH 計画・`.trash` 退避・large trash 安全弁・ロック・クラッシュリカバリを実装する。

## 安全不変条件（全 Phase 共通で死守）

1. Notion へ一切書き込まない（read-only クライアント）。
2. managed directory 内の「自分が管理していると確認できるファイル」だけを変更する。管理外ファイルは変更しない・退避しない。
3. API 失敗を削除と誤認しない（partial census / Search-incomplete では TRASH 生成禁止）。
4. Notion ページ ID を唯一の安定識別子にする（タイトルは表示名とパス材料）。
5. 親未更新でも子を探索する。
6. 改名 = MOVE / 移動 = 階層変更 として旧ファイル・旧ディレクトリを残さない。
7. 削除は即時完全削除せず `.trash` へ退避（grace_runs 経過後）。
8. 情報を黙って捨てない（unsupported/unknown は placeholder + サイドカー JSON + 警告）。
9. dry-run は完全に副作用ゼロ（DB / mtime / ログファイル / ディレクトリ作成すべて無し）。
10. 同一入力の 2 回目同期は content も mtime も無変更。
11. Token を log / DB / frontmatter / 例外メッセージに漏らさない。署名付き URL のクエリはログでマスク。
12. パストラバーサル / symlink escape で managed 外へ書かない。

## ディレクトリ構成

仕様 §32 に準拠（`src/{cli,commands,config,notion,domain,transform,storage,filesystem,assets,sync,logging}`、`tests/{unit,integration,e2e,fixtures,golden}`、`docs/{architecture.md,notion-api-findings.md,adr/}`、`examples/launchd/`、`scripts/`）。
