# ADR-005: 削除・アーカイブと .trash の安全戦略

- ステータス: 採用
- 日付: 2026-07-11

## コンテキスト

Notion 上でページが trash 化・ルート外へ移動・対象外化された場合、Obsidian 側でも管理対象から外す必要がある。しかし API 失敗（429/529/5xx/権限喪失）や部分取得を「削除」と誤認すると、大量のファイルを失う危険がある。過去ツールは削除・アーカイブを無視する問題があった。

## 決定

削除処理は**極めて保守的**に実装する。即時完全削除はせず `.trash` へ退避する。

### 削除判定の必須安全条件
- **census が完全成功（`deletion_allowed = true`）したルートでのみ**削除判定する。
- root 取得失敗・ページネーション途中失敗・Search incomplete・partial census では、そのルートのファイルを一切削除/退避しない。
- 429 / 529 / 5xx 発生時、権限喪失時は削除判定しない。
- `--page-id` 指定同期では他ページの削除判定をしない。
- dry-run では退避しない。管理対象ファイルのみを処理する。

### grace runs
- 前回存在したページが今回見つからない場合、可能なら個別取得で状態を確認する。
- 設定された連続回数（`deletion_grace_runs`、既定 2）だけ連続で見つからない場合にのみ退避する。

### 退避
- 退避先: `.trash/<YYYY-MM-DD>/<元の相対パス>`。同名衝突時はページ ID を付与。
- 理由を記録: `notion_in_trash` / `moved_out_of_scope` / `root_removed_from_config` / `confirmed_not_found` / `manual_reconcile`。
- 完全削除機能は初期バージョンでは実装しない。`.trash` からの復元手順は README に記載する。

### 大量退避の安全弁
- `maximum_trash_ratio`（既定 0.20）/ `maximum_trash_count`（既定 50）を超える場合、`--allow-large-trash` 無しでは Apply しない。

## Phase 2 / Phase 6 の分離

- **Phase 2**: `deletion_allowed` の判定までを実装。partial census から削除系アクションが生成可能な状態にならないことをテストで保証する。
- **Phase 6**: missing 回数更新・grace runs・TRASH 計画・`.trash` 退避・large trash 安全弁を実装する。

## 影響

- 一時的な API 障害でファイルを失わないことを最優先する。誤って退避しないことを、誤って残すことより優先する。
