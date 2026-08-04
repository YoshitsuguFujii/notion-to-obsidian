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

### table ブロックの Markdown 出力形式（実データ実測・2026-08-01）

- 実 Vault（103テーブル）を実測した結果、`<table>` 直下は必ず「任意の `<colgroup>...</colgroup>` → `<tr>...</tr>` の直接の繰り返し」であり、`<thead>` / `<tbody>` / `<tfoot>` によるラップは一度も出現しなかった。セルは常に `<td>` で、`header-row="true"` が付いた場合でも先頭行は `<th>` にならない（Notion独自の視覚スタイル属性であり、HTML5のセマンティックなヘッダー区別ではない）。
- 内訳: header-row属性なし 73件、`header-row="true"` 28件、`header-column="true"`のみ 1件、両属性 1件。colspan/rowspan（結合セル）は0件。
- `src/transform/enhanced-markdown.ts` の `tableMarkdown`（table→Markdownテーブル変換）は、この実測に基づき table 直下を「空白・任意のcolgroup・trのみ」と仮定した厳密パーサーで実装しており、`<thead>`/`<tbody>`/`<tfoot>` でラップされた入力は意図的に非対応（変換せず生HTML維持）としている。将来Notion側の出力形式が変わった場合は、この実測結果を更新し、パーサーの許容範囲も合わせて見直すこと。
- Block API の `table` block では、`table_row.cells` は公式仕様上「rich text配列の配列」（各セル自体がrich text配列）であり、`fallback-block-renderer.ts` の `table` ケースはこの前提（`cells`自体が配列であること・各セルも配列であること・長さが`table_width`と一致すること）を検証してから変換する。満たさない場合は変換せず`unsupported()`へ倒しsidecarへ保全する（API応答の欠損・仕様変更・mock不備を安全側に倒すため）。

## Enhanced Markdown の既知の変換欠陥（実Vault実測・2026-08-02）

`src/transform/enhanced-markdown.ts`が変換する "Enhanced Markdown" 文字列（Markdown API `retrieveMarkdown`が返す`markdown`フィールドの内容）に、Notion側の出力形式に起因する5件の変換欠陥が実データで確認された。実Vault（notion-to-obsidian管理下、31ファイル）を目視・remark再現テストで実測した。

- **欠陥1（synced_block文字化け、3/31ファイル）**: `<synced_block url="...">...</synced_block>`のタグ名にアンダースコアを含む。remarkのHTMLタグ名判定はアンダースコアを許可しないためHTMLノードとして認識されず、地の文としてエスケープされ文字化けする（`\<synced\_block ...`）。中身をタグを外して段落として展開する。
- **欠陥2（table_of_contents文字化け、27/31ファイル・最多）**: `<table_of_contents .../>`も同根の理由（タグ名のアンダースコア）で文字化けする。Notion自動生成の目次ウィジェットで著者情報を含まないため、変換せず削除する。
- **欠陥3（span装飾の生HTML残存、17/31ファイル）**: `<span color="...">`, `<span underline="...">`, `<span discussion-urls="...">`が変換されず生HTMLのまま本文に残る。実測した属性の組み合わせ分布（span出現の内訳）: `color`のみ 154件（`color="orange"` 152件、`color="red"` 1件、`color="green"` 1件）、`underline="true"`のみ 130件、`color`と`underline`の両方 3件、`discussion-urls`のみ 3件、`discussion-urls`と`color`の併存 2件。`class`属性のみ等、上記いずれも持たないspanは著者記述のHTML/CSS例として変換せず現状維持する必要がある（コードブロック内のspan例との区別）。
- **欠陥4（番号付きリスト内コードフェンスの崩壊、4/31ファイル）**: Notion Markdown APIは、番号付きリスト内のコードフェンスで開始行のみリスト継続に必要な分だけインデントし、本文行をインデントしない癖がある（推測: Notion側のMarkdown生成ロジックがリストマーカー幅の考慮を開始行にしか適用していない）。CommonMarkのリスト継続判定は本文行のインデント不足を検出するとリストをそこで終了させるため、開始フェンスが空codeノードに、本文行が独立paragraphに、閉じフェンスが孤立codeノードに分裂する。生Markdown文字列から該当範囲を直接スライスして修復する。
- **欠陥5（全角句読点隣接の太字破損、17/31ファイル）**: `**太字**`の直後が全角句読点（「、」「。」「」」「』」等）かつ直前が非空白・非句読点の場合、CommonMarkのflanking規則により開始デリミタとして認識されず`**`がエスケープされる。**これはCommonMark仕様上の正しい挙動であり、Notion側の不具合ではない**（欠陥1〜4とは無関係の別原因）。U+200B（ゼロ幅スペース）を該当箇所へ一時的に挿入しleft-flankingを成立させ、最終出力からは除去する。

対応は`src/transform/enhanced-markdown.ts`（欠陥1・2・3・5）と新規`src/transform/broken-code-fence.ts`（欠陥4）に実装済み。詳細な設計判断は`docs/adr/008-pre-parse-normalization-for-enhanced-markdown.md`を参照。

### 上記修正の残欠陥2件（2026-08-03）

初回修正（上記）の実装レビューで、以下2件の残存欠陥が判明し追加修正した。

- **欠陥4の修正漏れ**: 崩壊コードフェンスの検出が、終了候補ノードの`lang`の有無のみで判定していたため、4スペースインデントによるコードブロックを誤って崩壊シグネチャの終了ノードと認識し、その中身を誤って吸収する（本文が消失する）ケースがあった。終了候補が生Markdown文字列上で実際にfence marker行であり、info stringを持たず、文字種・長さが開始フェンスと整合することを検証するよう修正した。インデント幅は判定に使わない（Notion Markdown APIの「開始行のみインデントし本文行・閉じフェンス跡はインデントしない」という既知の癖があり、開始フェンスとのインデント一致を要求すると、この典型的なパターンを誤って拒否してしまうため）。
- **欠陥5修正の副作用**: `removeZeroWidthSpaces`が最終出力中のU+200Bを無条件に除去する実装だったため、欠陥5の修正で挿入した分だけでなく、Notion本文に著者が元から書いていたU+200Bも区別なく削除していた。パイプライン先頭で既存のU+200Bを衝突しないsentinel文字列（Private Use Areaの1文字）へ一時退避し、除去処理後に復元することで、挿入分のみを除去対象にするよう修正した。

### 上記修正の境界ケース2件（2026-08-04）

上記追加修正のレビューで、以下2件の境界ケースが判明し追加修正した。

- **終了候補の先頭空白の未制限**: 4スペースインデントによる本物のインデントコードブロックの内容が偶然fence marker風の文字列（例: ` ``` `）で始まる場合、これを崩壊シグネチャの終了候補と誤認識し、著者が書いたその文字列自体を消失させるケースがあった。終了候補の先頭空白をCommonMarkのfenced codeとして成立する0〜3文字に制限して修正した。
- **独立した正常なコードブロックの誤通過**: 崩壊開始の直後に開始・終了フェンスが揃った独立した正常なコードブロックが続く場合、これを崩壊シグネチャの終了候補として誤って通過させると、後続処理がそのコード内容を生Markdown文字列として再parseする際、コード内容が通常のMarkdown構文として解釈され変換されてしまうことが判明した（安全不変条件「code内を変更しない」に抵触）。終了候補ノード自身が有効な閉じフェンス行を持ち、かつそのフェンス文字種が崩壊開始ノードと一致する場合は崩壊シグネチャの終了ノードとして扱わないfail-closed判定を追加した。この結果、崩壊終了フェンス跡が後続の別リストの崩壊フェンスを巻き込み、かつ両方が同じフェンス文字種を使うケースの再帰修復は拒否されるようになったが（既知の制約として許容）、テキスト内容自体は失われずMarkdown構文として誤って再解釈されることもない。2つの崩壊リストが異なるフェンス文字種を使う場合は拒否されず、両方とも正しく再帰的に修復される。

あわせて、U+200B退避のsentinelを単一固定文字から複数候補の動的選択に変更し、sentinel自体が本文と衝突するリスクを低減した。

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
