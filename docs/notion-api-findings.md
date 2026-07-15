# Notion API 調査結果（2026-07 時点）

本ツールの設計根拠となる Notion 公式仕様の確認結果を記録する。すべて公式ドキュメント（developers.notion.com）で確認した事実に基づく。ブログ等の非公式情報より公式仕様を優先している。

## API バージョンと SDK

- 採用 API バージョン: **`2026-03-11`**（コンストラクタで `notionVersion: '2026-03-11'` を指定、または `Notion-Version` ヘッダで送出）。
- 公式 SDK: **`@notionhq/client`**。`2025-09-03` と `2026-03-11` の両バージョンに対応。
- `2026-03-11` では後述の Markdown API（`retrieveMarkdown`）と Data Source モデルが利用可能。

## Markdown API（本文取得の主経路）

- エンドポイント: `GET /v1/pages/{page_id}/markdown`
- SDK: `notion.pages.retrieveMarkdown({ page_id })`
- 必須ヘッダ: `Notion-Version: 2026-03-11`
- リクエスト:
  - `page_id`（path, 必須）: ページIDまたはブロックID。truncated レスポンス由来の非ナビゲート block ID もここに渡せる。
  - `include_transcript`（query, 任意, 既定 false）: 会議ノートのトランスクリプトを含めるか。
- レスポンス `page_markdown` オブジェクト:
  - `object`: 常に `"page_markdown"`
  - `id`: 対象ページ/ブロックの UUID
  - `markdown`: Enhanced Markdown 文字列（本文全体）
  - `truncated`: boolean。約 20,000 block の上限を超えたか
  - `unknown_block_ids`: 配列（最大 100 件）。読み込めなかった block ID。Markdown 内に `<unknown>` タグとして現れる
- **ページネーションは存在しない**。`truncated` または `unknown_block_ids` がある場合、その block ID を `page_id` として再取得し、サブツリーを追加取得する方式。
- 読み取り権限（read content capabilities）が無い connection では 403。

### 本ツールでの扱い（重要）
- `unknown_block_ids` を再取得した結果は、元 Markdown 内の対応位置を**一意かつ確実に特定できる場合だけ**マージする。
- 位置を保証できない場合は、推測でページ末尾等に挿入せず、対象ページ全体を **Block API ベースのフォールバックレンダラー**へ切り替える。
- 追加取得が **404** の場合は「削除」とみなさず、権限不足/取得不能として警告する。
- いずれの場合も情報を黙って破棄せず、placeholder + サイドカー JSON + 警告を残す。
- `<unknown>` は属性付きタグとして返る場合も想定して処理する。`NOTION_TEST_TOKEN`を設定できる環境では、read-only integration testで属性の有無を含む実API形式を継続確認する。

## Block API（フォールバック・補助）

- Markdown API だけで済ませられると仮定しない。以下で Block API を補助的に使う:
  - `truncated: true` / `unknown_block_ids` が存在 / `<unknown>` が出力される / Markdown 未対応ブロック
  - 添付ファイルの安定識別に block ID が必要なとき
  - child page / child database の正確な構造検出、内部リンク解決、ページ階層の正確な構築
- 子要素の列挙は `blocks.children.list`（ページネーションあり）。`child_page` / `child_database` ブロックで子ページ・子DBを検出する。

## Database / Data Source モデル（2026-03-11）

- **database はコンテナ**であり、複数の **data source**（レコードのテーブル）を保持する。
- `databases.query` は**レガシー**で、`2026-03-11` ヘッダ使用時は利用不可（呼ぶと警告/エラー）。代わりに `notion.dataSources.query({ data_source_id, ... })` を使う。
- `child_database` ブロックが参照する database を retrieve すると `data_sources` 配列（id 群）が得られる。linked view 経由で同じ data source を複数回発見しうるため **ID で重複排除**する。
- 実装とテストは `databases.retrieve({ database_id })` が `{ id, data_sources: [{ id, name }] }` を返す形状に依存する。mock clientもこの形状に合わせ、`NOTION_TEST_TOKEN`を設定できる環境ではread-only integration testで実API応答との一致を継続確認する。

## レート制限とエラー

- レート制限: 平均 **3 req/s / connection**（バースト許容）。加えてワークスペース単位の制限（プラン依存）。
- 超過時: **HTTP 429**（`error code: rate_limited`）。過負荷時: **HTTP 529**（`service_overload`）。`additional_data.rate_limit_reason` に理由。
- **`Retry-After` ヘッダ**（整数秒）が返る場合は必ず尊重する。それ以外は指数バックオフ + jitter。
- 本ツール既定: `request_rate_per_second: 2.5`, `concurrency: 2`（3 req/s をやや下回る安全側）。
- リトライ対象: 429 / 529 / 500 / 502 / 503 / 504 / ネットワークタイムアウト / 接続リセット。認証・権限・validation エラーは即分類し無駄なリトライをしない。
- ペイロード制約（主に書き込み側だが参考）: 最大 1000 block / 500KB。

## 一時 URL（添付ファイル）

- ファイル/画像の URL は署名付きの一時 URL。**最終 Markdown にそのまま保存してはならない**。
- クエリ文字列が変わっただけで別ファイル扱いしないため、差分判定には ETag / Last-Modified / Content-Length / content hash / block の `last_edited_time` を用いる。

## 削除・アーカイブの検出

- ページ/ブロック/データソースは `in_trash`（旧 `archived`）で trash 状態を判定できる。
- 「ルート配下から外れた」「親がルート外に出た」もツール側の census で検出する。ただし API 失敗（429/529/5xx/権限）を削除と誤認しないため、**census が完全成功したルートでのみ削除判定を許可**する（`deletion_allowed`）。
