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

- 欠陥4の修正漏れ: 崩壊シグネチャの終了候補ノードを`lang`の有無のみで判定していたため、4スペースインデントによるコードブロックを誤って終了候補と認識し中身を誤って吸収するケースがあった。終了候補が生Markdown文字列上で実際にfence marker行（`` ` ``または`~`の3連続以上、info stringなし、文字種・長さが開始フェンスと整合）であることを検証するよう修正した（`isCollapsedFenceTerminator`）。
- 欠陥5修正の副作用: `removeZeroWidthSpaces`が最終出力中のU+200Bを無条件に除去していたため、pre-parse正規化で挿入した分だけでなく、Notion本文に著者が元から書いていたU+200Bも区別なく削除していた。パイプライン先頭で既存のU+200Bを衝突しないsentinel文字（Private Use Areaの1文字）へ一時退避し、除去処理後に復元することで、挿入分のみを除去対象にするよう修正した。

### 追記（2026-08-04・境界ケースの追加修正）

上記追記の実装を再度レビューしたところ、次の2件の境界ケースが判明し追加対応した。

- 終了候補の先頭空白に上限がなかったため、4スペースインデントによる本物のインデントコードブロックの内容が偶然fence marker風の文字列で始まる場合、その文字列自体を消失させるケースがあった。終了候補の先頭空白をCommonMarkのfenced codeとして成立する0〜3文字に制限して修正した（開始候補の先頭空白には引き続き上限を設けない。番号付きリストの項目番号が2桁になるとマーカー幅が変わり絶対インデントが変動するため）。
- 開始・終了フェンスが揃った独立した正常なコードブロックを`isCollapsedFenceTerminator`が誤って通過させると、後続の`extractTrailingContent`がそのコード内容を生Markdown文字列として再parseする際、コード内容（例: `**not bold**`）が通常のMarkdown構文として解釈され変換されてしまうことが実データ検証で判明した（「情報は失われない」だけでは不十分で、AGENTS.mdの安全不変条件「code内を変更しない」に直接抵触する）。終了候補ノード自身が有効な閉じフェンス行を持ち、かつそのフェンス文字種が崩壊開始ノードと一致する場合（＝独立した正常なコードブロック）は崩壊シグネチャの終了ノードとして扱わないfail-closed判定を追加した（`hasOwnClosingFenceLine`）。崩壊終了フェンス跡が後続の別リストの崩壊フェンスを巻き込み、かつ両方のリストが同じフェンス文字種を使うケースはこの判定で拒否されるようになり、既存の再帰修復機能の一部が後退した。ただし、この場合もテキスト内容自体は失われずMarkdown構文として誤って再解釈されることもない。なお、2つの崩壊リストが異なるフェンス文字種（例: 1番目が`` ``` ``、2番目が`~~~`）を使う場合は文字種の不一致により拒否されず、両方とも正しく再帰的に修復される。
- あわせて、U+200B退避のsentinelを単一固定文字（U+E000）から複数候補（U+E000〜U+E00F）の動的選択に変更し、sentinel自体が本文と衝突するリスクを低減した。

### 追記（2026-08-05・実Vault表示崩れ起点の追加修正）

Phase 7完了後の実`sync --full`実行後、Obsidianでの実Vault目視確認により、上記の欠陥4対応だけでは解消しない表示崩れが1件見つかった。原因調査の結果、欠陥4には既知の「孤立codeノード型」シグネチャとは別に、閉じフェンス行もタブでインデントされ、CommonMarkのlazy continuationにより直前のparagraphへ生文字列として吸収される「paragraph吸収型」の第2シグネチャが存在することが判明した（詳細は`docs/notion-api-findings.md`「欠陥4の第2実測シグネチャ」参照）。

#### 検出範囲の設計: ASTで開始位置を限定した後にraw offsetで終了候補を検証する

第2シグネチャの検出は、崩壊開始ノード（ASTシグネチャで確定: ordered listの最後のlistItem末尾がlang付き・value空のcodeノードであり、かつ生Markdown上で単独の未閉鎖開始フェンス行であること）が確定した場合のみ、その直後に連続するparagraph siblingの`position`が示すraw範囲だけを物理行単位で走査する。文書全体を無制限に正規表現探索する設計は採用しなかった。理由は次の3点。

1. 崩壊シグネチャの成立自体がASTで判別可能な限定条件（ordered listの末尾）を要求しており、この条件を経由しない探索は「たまたまフェンス風の行がある通常の文章」を誤検出するリスクを増やす。
2. 探索範囲を「開始ノード確定後の連続paragraph」に限定することで、既存の孤立codeノード型（経路1）と同じ安全性設計思想（ASTシグネチャによる絞り込み→raw文字列での形式検証）を踏襲できる。
3. paragraphのAST構造（children配列、inline要素）は一切参照しない。paragraph内のテキストが既にstrong/inlineCode/link等のinlineノードへ分割されている場合があり、inline構造を材料にすると、既にMarkdownとして解釈された内容を誤って書き換える危険がある。`position`のoffsetのみを使い、raw文字列を直接スライスする。

終了候補が探索範囲内に複数見つかった場合、どれが本当の終端か判別できないためpre-scan・本修復のいずれもfail-closedとする（修復しない）。

#### code本文の保持方法: raw保持、終了後本文だけをfragmentとして再parseする

崩壊code本文は、開始フェンス行の直後から終了フェンス行の直前までの生Markdown文字列をbyte-for-byteでスライスし、`code`ノードの`value`へ直接設定する（parse・trim・dedent・stringifyを一切行わない）。終了フェンス行より後、同一paragraph内に吸収されていた後続本文（trailing）だけを独立にfragment parseし、修復済みcodeノードの直後へ差し戻す。この非対称な扱い（code本文はraw保持、trailingのみ再parse）は、code本文の中身（`**not bold**`、バッククォート、HTML等）を誤ってMarkdown構文として再解釈しないための安全不変条件を維持するため。

#### pre-scanとpre-parse正規化除外範囲の分離設計

崩壊コードフェンスのcode本文は、初回parse時点ではcodeノードとして認識されないため、既存の`renameKnownUnderscoreTags`/`insertZeroWidthSpaceForBoldFlanking`が使う除外範囲（`collectUneditableRanges`、code/inlineCodeノードのみ対象）に含まれない。対応せず放置すると、pre-parse正規化がcode本文を書き換えてしまい（`<synced_block>`→`<synced-block>`への誤リネーム、`**`直後への意図しないU+200B挿入）、「code本文は元のNotion Markdownと完全一致する」という安全不変条件に違反する。

対応として、pre-parse正規化（rename・U+200B挿入）より前の時点で、`repairBrokenCodeFences`と同じ崩壊シグネチャ判定ロジックをASTを書き換えずに範囲収集のみ行う形で先に実行し（`collectCollapsedCodeRangesDeep`）、崩壊code本文の範囲を確定してpre-parse正規化の除外範囲に追加する。

- `renameKnownUnderscoreTags`はアンダースコア→ハイフンの1文字対1文字置換のみで文字数を変えないため、確定した範囲のoffsetはそのまま次の工程へ引き継げる。
- `insertZeroWidthSpaceForBoldFlanking`はU+200B挿入により文字数が変わるため、挿入位置リストを使って保護範囲のoffsetを挿入後の座標へ調整する（`adjustOffsetForInsertions`）。
- 本修復（`repairBrokenCodeFences`）は、確定した候補範囲（開始・終了offset）がpre-scanで検出された保護範囲のいずれかと完全一致する場合のみ実際に修復する（`isProtectedRangeConfirmed`）。一致しない場合、pre-scanで保護されなかった範囲がpre-parse正規化の影響を受けた可能性を排除できないため修復しない。
- pre-scan・本修復のいずれも、崩壊シグネチャ確定時に後続本文（trailing）をfragment化して再帰的に同じ処理を適用する設計になっている（隣接する崩壊リストの再帰修復に対応するため）。pre-scanもtrailingを同じ手順で再帰的に辿り、ネストした崩壊コードフェンスの保護範囲を検出する。本修復側のtrailing再帰呼び出しには、外側の保護範囲のうちtrailing範囲に収まるものをtrailing相対offsetへ変換して引き継ぐ（`extractProtectedRangesForTrailing`。pre-scan側の変換と対称）。

#### protected rangeの整合性検証とfail-closed方針

保護範囲は使用前に必ず整合性検証（`validateProtectedRanges`）を通す。半開区間`[start, end)`で`0 <= start < end <= textLength`を満たさないrangeが1件でもあれば、pre-scan全体を信頼できないとみなし空配列を返す（fail-closed）。完全一致するrangeはdeduplicateするが、異なるrange同士が部分的にでも重なる場合は「重なったrangeを広くmergeして保護する」設計を採らず、pre-scan全体をfail-closedとする（誤検出した範囲までcode扱いして通常のMarkdown変換を止めてしまうことを避けるため）。この検証は、pre-scan直後・U+200B挿入によるoffset調整後・trailing相対座標変換後のそれぞれで実行する。

さらに、`insertZeroWidthSpaceForBoldFlanking`には防御的チェックを追加した。`isWithinRange`による除外が正しく機能していれば到達しない想定だが、万一保護範囲の内部へU+200Bを挿入しようとしていた場合は実装のバグとみなし、補正全体を中止して未変更のmarkdownを返す。

#### synced_block等のfragment内は対象外（既知の制約）

pre-scanはtransformParentと同じ再帰構造でdocumentのASTツリー全体（listItem内のネストしたlist等）を辿るが、`synced_block`等の展開で生成される別sourceText基準のfragment（`transformParent(fragment, syncedBlock, [])`のように空配列を渡す経路）は対象外とする。fragment内で崩壊シグネチャが検出されても、対応する保護範囲を確認できないため常にfail-closedとなり、修復されない。これは意図的な機能後退である（従来はfragment内でもコードフェンス修復が動く可能性があった）。安全側に倒れる（未修復のまま生文字列として保持され、情報は失われず、code内容もMarkdown構文として誤って再解釈されない）ため許容する。fragment自体は正規化パイプラインの外側で動的に生成されるため、保護範囲の由来（pre-parse正規化前のoffsetとの対応関係）を証明できない、というのがこの制約の理由。

#### U+200B全sentinel候補衝突時の対応変更

Phase 7では、U+200B退避のsentinel候補（U+E000〜U+E00F）が全て本文と衝突する場合、退避を諦めて既存挙動（`removeZeroWidthSpaces`による無条件全除去）にフォールバックしていた。これは著者記述のU+200Bまで削除してしまうため、安全不変条件8（黙って情報を捨てない）に抵触することが判明し、Phase 8で対応を変更した。全候補衝突時は、太字flanking補正の挿入（`insertZeroWidthSpaceForBoldFlanking`）と最終的なU+200B除去（`removeZeroWidthSpaces`）の両方をスキップし、著者記述のU+200Bを完全に保持する（太字flanking補正を諦める方を優先する）。

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
- 変換結果が変わるため`TRANSFORM_VERSION`を`'8'`から`'9'`へバンプし、既存Vaultを再変換対象にした（`src/sync/orchestrator.ts`）。上記追記の修正でも変換結果が変わるため、`'9'`から`'10'`、さらに境界ケースの追加修正で`'10'`から`'11'`へ再度バンプした。2026-08-05の第2実測シグネチャ対応でも変換結果が変わるため、`'11'`から`'12'`へ再度バンプした。
- `src/transform/broken-code-fence.ts`に`collectCollapsedCodeRanges`/`collectCollapsedCodeRangesDeep`/`validateProtectedRanges`/`ProtectedRange`型が追加され、`repairBrokenCodeFences`が`protectedRanges`引数を必須で受け取るシグネチャに変更された。
- pre-parse正規化はNotion固有の既知パターン（タグ名・flanking規則）に限定したホワイトリスト方式を維持し、ADR-006が禁じる「Markdown全体への正規表現置換」には踏み込まない。将来の欠陥修正でpre-parse正規化を追加する場合も、この限定範囲の原則を踏襲すること。
