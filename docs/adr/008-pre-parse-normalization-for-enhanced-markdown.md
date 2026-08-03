# ADR-008: Enhanced Markdown変換にpre-parse正規化を追加する

- ステータス: 採用
- 日付: 2026-08-03

## コンテキスト

ADR-006はEnhanced Markdownの変換をremarkのAST変換（parse→変換→stringify）に限定し、「Markdown全体への正規表現置換を避け、構文境界を保てる」ことを理由に採用した。

実Vault（31ファイル）を実測した結果、Notion Markdown API由来の5件の変換欠陥（`docs/notion-api-findings.md`「Enhanced Markdownの既知の変換欠陥」参照）のうち、欠陥1・2・4・5はASTへ正しく変換される前の時点、すなわちremarkのparse自体が意図通りに機能しないケースであることが判明した。

- 欠陥1・2: タグ名にアンダースコアを含む（`synced_block`, `table_of_contents`）ため、remarkのHTMLタグ名判定に失敗しHTMLノードとして認識されない。
- 欠陥4: 番号付きリスト内のコードフェンスがCommonMarkのリスト継続判定により崩壊し、期待した`code`ノードに変換されない。
- 欠陥5: `**`直後の全角句読点によりCommonMarkのflanking規則を満たせず、`strong`ノードとして認識されない。

これらはASTが正しく組み上がった後の変換ロジック（ADR-006がカバーする範囲）では対処できず、parseに通す前の生文字列操作が必要になる。

## 決定

`transformEnhancedMarkdown`のパイプライン内部に「pre-parse正規化」工程を追加する（外部から見えるパイプライン順序: 1. Enhanced Markdown変換 → 2. アセット等のAST後処理 → 3. 最終段階での文字列置換、は変更しない。pre-parse正規化はEnhanced Markdown変換の内部ステップに閉じる）。

pre-parse正規化は、既に`src/transform/signed-asset-urls.ts`で確立していた手法（remarkで1度parseのみ行い`code`/`inlineCode`ノードの位置範囲を収集し、その範囲外だけに生文字列への局所置換を行う）をそのまま踏襲する。全体への正規表現置換ではなく、「除外範囲を確定した上での局所置換」である点で、ADR-006の「正規表現全体置換を避ける」という原則とは矛盾しない。

- 欠陥1・2: 既知タグ名（`synced_block`, `table_of_contents`）のみを対象にしたホワイトリスト方式でアンダースコアをハイフンへリネームし、remarkがHTMLノードとして認識できる形にする。任意のアンダースコア入りタグ名への汎用適用はしない。
- 欠陥5: `**`直後が全角句読点かつ直前が非空白・非句読点の場合にU+200B（ゼロ幅スペース）を挿入し、CommonMarkのleft-flanking条件を成立させる。stringify直後・後段の文字列置換より前にU+200Bを除去する。
- 欠陥4: pre-parseで検出した崩壊シグネチャ（空code+lang付き→連続paragraph→孤立code+lang無し）について、生Markdown文字列から該当範囲を直接スライスして正しい`code`ノードへ再構成する（`src/transform/broken-code-fence.ts`）。

欠陥3（span装飾）は、既存のAST変換（`transformParent`の拡張）のみで対応可能なため、pre-parse正規化を必要としない。

### 追記（2026-08-03・外部レビュー起点の追加修正）

上記実装のレビューで、次の2件の残存欠陥が判明し追加対応した。

- 欠陥4の修正漏れ: 崩壊シグネチャの終了候補ノードを`lang`の有無のみで判定していたため、4スペースインデントによるコードブロックを誤って終了候補と認識し中身を誤って吸収するケースがあった。終了候補が生Markdown文字列上で実際にfence marker行（`` ` ``または`~`の3連続以上、info stringなし、文字種・長さが開始フェンスと整合）であることを検証するよう修正した（`isCollapsedFenceTerminator`）。なお、開始・終了フェンスが揃った独立した正常なコードブロックがこの検証を通過してしまう場合があるが、後続の`extractTrailingContent`が巻き込んだ内容を再parseするため情報は失われない。
- 欠陥5修正の副作用: `removeZeroWidthSpaces`が最終出力中のU+200Bを無条件に除去していたため、pre-parse正規化で挿入した分だけでなく、Notion本文に著者が元から書いていたU+200Bも区別なく削除していた。パイプライン先頭で既存のU+200Bを衝突しないsentinel文字（Private Use Areaの1文字）へ一時退避し、除去処理後に復元することで、挿入分のみを除去対象にするよう修正した。

### table_of_contentsの削除はADR-006「未知は保持」方針の例外

ADR-006は「toggleと未知HTMLは情報保持のためそのまま残す」方針を採る。`table_of_contents`はこの原則の例外である。Notion自動生成の目次ウィジェットであり著者が記述した情報を一切含まないため、変換せず残すのではなく黙って削除する（削除しても情報損失にならない）。この判断はADR-006の一般方針を覆すものではなく、「自動生成で著者情報を含まないことが確実な特定の1タグ」に限定した個別の例外として扱う。

## 理由

- `signed-asset-urls.ts`が既に同じ「parseして除外範囲を集め、生文字列に局所置換する」設計を確立しており、アーキテクチャ上の新規パターンではなく既存パターンの拡張である。
- 欠陥1・2のタグ名リネームを「タグ名を有効な形へ書き換えてASTに正しく載せ、その後のAST変換で最終出力を決定する」設計にすることで、一時的な置換痕跡の復元漏れリスクをなくした。
- 欠陥5のU+200B挿入は、remarkが実際に使用するmicromarkの分類関数（`unicodePunctuation`/`unicodeWhitespace`、`micromark-util-character`）をそのまま再利用しており、自前実装による判定基準のズレを避けている。

## 代替案と不採用理由

- **欠陥1・2の汎用リネーム（任意のアンダースコア入りタグを機械的にリネーム）**: コードブロック内でユーザーが本文として書いた`<my_tag>`等を誤って書き換えるリスクがあるため不採用。既知タグ名のホワイトリスト方式を採用した。
- **欠陥5: 句読点・空白の判定ロジックを自前実装する案**: micromarkの分類関数（`unicodePunctuation`/`unicodeWhitespace`）に頼らず独自に正規表現等で判定する案は、remarkの実際の判定基準とズレて誤検出を招くリスクがあるため不採用。実装時に調査した結果、判定関数を提供する`micromark-util-character`は既にremark-parseの間接依存としてnode_modulesに存在しており、これを直接依存として明示的に追加した上でそのまま再利用する方式を採用した（将来のremark/micromarkのメジャーアップデートで内部依存のmicromarkバージョンが変わった場合、直接importしている分類関数の判定基準が実際のパーサの判定と乖離する可能性がある既知の制約として認識している。回帰テストがremark系の依存更新時に引き続き成功することを確認すれば乖離は検知できる）。
- **table_of_contentsをHTMLコメント等で痕跡を残す案**: 27/31ファイルに出現するため本文が冗長になる。自動生成UIで著者情報を含まないため、黙って削除する方針を採用した。

## 影響

- `src/transform/enhanced-markdown.ts`にpre-parse正規化のヘルパー（`collectUneditableRanges`, `renameKnownUnderscoreTags`, `insertZeroWidthSpaceForBoldFlanking`等）と、AST変換の拡張（span変換、崩壊コードフェンス修復の呼び出し）が追加された。
- `src/transform/broken-code-fence.ts`が新規追加コンポーネントとして加わった。
- `package.json`に`micromark-util-character`を直接依存として追加した（既存のremark-parseの間接依存を明示化したもので、新規機能追加ではない）。
- 変換結果が変わるため`TRANSFORM_VERSION`を`'8'`から`'9'`へバンプし、既存Vaultを再変換対象にした（`src/sync/orchestrator.ts`）。上記追記の修正でも変換結果が変わるため、`'9'`から`'10'`へ再度バンプした。
- pre-parse正規化はNotion固有の既知パターン（タグ名・flanking規則）に限定したホワイトリスト方式を維持し、ADR-006が禁じる「Markdown全体への正規表現置換」には踏み込まない。将来の欠陥修正でpre-parse正規化を追加する場合も、この限定範囲の原則を踏襲すること。
