# ADR-003: 同期状態を better-sqlite3 で管理する

- ステータス: 採用
- 日付: 2026-07-11

## コンテキスト

同期状態（resources / assets / sync_runs / roots / warnings）を永続化する必要がある。候補は Node 組み込みの `node:sqlite` と、実績あるネイティブライブラリ `better-sqlite3`。実行環境は Node v24.5.0。

## 決定

**`better-sqlite3`** を採用する。ただし storage 層（`StateStore` interface とその SQLite 実装）に完全に隔離する。

## 理由

- Node 24 の `node:sqlite` は **Experimental**（実行時に ExperimentalWarning が出る、API が将来変更されうる）。長期運用ツールとしては、依存ゼロよりも **API の安定性と実績**を優先する（ユーザー判断）。
- `better-sqlite3` は同期 API で実装が単純になり、transaction・prepared statement が扱いやすい。

## 設計上の制約

- `better-sqlite3` を直接参照するコードは storage 層（`src/storage/`）に閉じ込め、SQL 文をドメイン層へ漏らさない。ドメイン層は `StateStore` interface のみに依存する。
- スキーマにバージョン番号と migration 機構（`src/storage/migrations/`）を設ける。
- `foreign_keys = ON` を有効化する。
- `busy_timeout` を設定し、ロック競合時に即失敗しないようにする。
- **WAL モードの採否**: 単一プロセス前提（多重起動はロックで防止）だが、クラッシュ耐性と読み取り一貫性のため WAL を採用する方針で検討する。最終判断と理由は実装時に本 ADR へ追記する。
- transaction を適切に使い、接続の close を保証する（プロセス終了時・エラー時とも）。
- テストは `:memory:` または一時ファイル DB を使う。

## 影響

- ネイティブビルドのため **Xcode Command Line Tools が必要**になる可能性がある。README と本 ADR に明記する。
- 将来 `node:sqlite` が Stable 化したら、`StateStore` の SQLite 実装差し替えで移行できる。移行時の影響範囲: (1) 接続生成/close、(2) prepared statement API の差異、(3) transaction ヘルパ、(4) migration 実行部。ドメイン層・sync 層は `StateStore` interface のみ参照するため無影響。
