# ADR-007: 署名付き URL の置換範囲は構文で証明できる箇所に限り、Plan/Apply 整合性は fingerprint で比較する

- ステータス: 採用
- 日付: 2026-07-31

## コンテキスト

Notion が返す Markdown 本文には、アセットの一時的な署名付き URL（AWS presigned URL 等）がそのまま残ることがある。これを安定した参照へ置換する処理（`src/transform/signed-asset-urls.ts`）で、繰り返し本文欠落の欠陥が見つかった（Stage 29、Stage 34、Stage 35 commit 1〜1.2）。原因はいずれも、「署名付き URL の直後にどこまでが URL でどこからが地の文かを、区切り文字なしの生文字列から一意に決定できない」ことに起因していた。

Stage 35 では、構文（Markdown リンク・画像・autolink・HTML 属性）で範囲が確定できる箇所だけを置換し、確定できない裸 URL は置換せず安全停止する設計へ再構成した。この過程で 2 つの設計判断が生じ、いずれも公開リポジトリの恒久的な設計として記録する必要があると判断した。

## 決定

### 1. 裸 URL への置換は行わない。実績のある URL lexer を使っても解決しない

裸URL（Markdownリンク・画像・autolink・HTML属性のいずれの構文にも属さない、地の文に直接現れる URL）は、境界を証明する情報が原理的に存在しないため、どのような lexer / linkifier を採用しても安全に置換できない。

実測での確認: `remark-gfm`（実績のある GFM 準拠拡張）の literal autolink 検出を、必須のあいまい境界ケースに対して実行した。

| 入力 | GFM autolink-literal の判定 |
|---|---|
| 署名URL + `(note)` | `(note)` を含めて丸ごと URL と誤認 |
| 署名URL + `**bold**` | `**bold` まで誤って含める |
| 署名URL + `_italic_` | `_italic` まで誤って含める |
| 署名URL + `next` / `-next` | 境界なく誤って含める |
| 署名URL + `、後ろ` / `。後ろ` | 全角句読点で終端しない |
| 署名URL + `.` / `,` / `)` | ASCII 句読点のみ正しく除去 |

誤って吸収された `(note)` 込みの文字列は `new URL()` で parse に成功し、署名パラメータの検出（`hasSignatureParameter`）も真になる。この誤吸収 span をそのまま置換に使うと、`stableReferenceUrl` が `(note)` を含まない安定参照を返し、本文欠落が再発する。

したがって、**裸 URL は構文で範囲が確定する箇所（Markdown リンク・画像の destination、autolink、HTML の引用符付き属性値）に含まれない限り、置換せず安全停止する**。実績のある lexer の採用可否とは無関係に、この方針を維持する。

### 2. Plan/Apply の整合性は offset ではなく fingerprint の多重集合で比較する

`orchestrator.ts` は Plan 段階で確定した署名 URL の置換結果と、Apply 段階（アセットダウンロード後）で再計算した置換結果が一致することを確認してから Markdown を書き込む。この一致判定を、単なる件数比較（`replacedCount` 等 3 つの数値の一致）から、置換内容の fingerprint 比較へ変更した。

- 比較対象は `sourceHash`（置換元 URL の sha256）・`replacement`（置換後の値）・`context`（`markdown-link` / `markdown-image` / `autolink` / `html-attribute` / `html-rescue` / `bare-url` の構文分類）の組。
- `start` / `end`（本文中の絶対位置）は比較に使わない。Plan と Apply の間でアセット処理（`applyPlannedPageAssets`）が本文の他の部分を書き換えるため、署名 URL 自体が変わっていなくても位置は正当にずれうる。
- 同じ署名 URL が複数回現れる場合を区別できるよう、`Set` ではなく重複を保持した多重集合として、決定論的にソートしてから比較する（`replacementsMatch` / `unsafeOccurrencesMatch`）。
- `context` を比較対象に含める理由: 元 URL の hash と置換後の値だけでは、「同じ URL が Plan では画像記法として、Apply では HTML 属性として抽出された」といった構文分類の変化を見逃す。構文分類が変わったということは抽出判断自体が変わった可能性があり、安全側に倒して不一致として扱う。

これにより、「件数は一致するが異なる URL を置換した」「同じ URL だが構文分類が変わった」という、旧来の件数比較では検出できなかった不整合を検出できるようになった。

## 既知の制約（この ADR の範囲外）

- fingerprint 検証は `applyPlannedPageAssets`（アセットのダウンロードと最終パスへの書き込み）の**後**に行われる。したがって fingerprint 不一致で安全停止しても、その時点までにアセットファイル自体は既にディスクへ書き込まれている場合がある。Markdown 本文と resource DB は更新されないため、次回同期で回復可能ではあるが、「安全停止 = ファイルシステムへの副作用ゼロ」ではない。アセットのダウンロードと commit を fingerprint 検証より後に遅延させる二段階 Apply は、独立した設計課題として tasklist へ分離する。**fingerprint 比較が通常到達不能なため（下記）、この副作用が現状の自然入力で顕在化することもない。将来この分岐が到達可能になった場合に問題となる。**
- `Replacement.start` / `end` は比較には使わないが、診断・将来のツール向けに型としては保持している。

## Plan/Apply 不一致経路は現状の不変条件下では到達不能（2026-07-31・実測で確認）

Apply 時の fingerprint 比較（`replacementsMatch` / `unsafeOccurrencesMatch`）を、`downloadAsset` の成否を変えるモックを使って自然な入力から不一致にできるか実測で検証した。以下の不変条件により、現状の実装では到達できないことを確認した。

- **Plan 時点で unsafe（境界未確定・解析不能）が 1 件でもあれば、Apply へ進む前に停止する**（`orchestrator.ts:812` 付近。Apply 時の fingerprint 比較より前段のゲート）。実測: アセット画像記法へ密着させた裸 URL を用意したところ、Apply 時の比較に到達する前にこの Plan 時点のゲートで安全停止した。
- **署名付きアセット URL は、Plan・Apply のいずれも `finalizePageBody` に渡る前に、ローカルパスまたは同一の安定参照（`stableReferenceUrl`）へ解決される**（`applyPlannedPageAssets` の `rewriteAssetUrls` が先に走る）。したがって `replaceRetainedSignedUrls` がアセット自身の署名付き URL を生のまま見る経路はない。
- **ブロックに対応しない（ambiguous）候補の安定参照は Plan 時点で 1 回だけ計算され、Apply 時点でも同じ値がそのまま再利用される**（`plan.stableReferences` を Apply の `replacements` 初期値として再利用）。

この 3 点により、**現状の実装では Plan/Apply の replacement fingerprint が自然入力によって不一致になる経路は無い**。ただし、これは「比較が不要」を意味しない。以下のいずれかが変われば到達可能になりうるため、fingerprint 比較は防御的な不変条件検査として保持する：

- アセット URL 書き換えの順序（`rewriteAssetUrls` を `finalizePageBody` より後に動かす等）
- `stableReferences` の生成・再利用方法（Apply 時に再計算する設計へ変える等）
- Apply 時のアセット再取得・再マッピングのロジック
- `finalizePageBody` が対象とする範囲の変更
- title や property を Apply 時に再生成する設計への変更

比較関数自体（`replacementsMatch` / `unsafeOccurrencesMatch`）はユニットテストで固定済みであり、`orchestrator.ts` 側の配線（不一致なら `DomainError('safety')` を投げるだけの薄い分岐）に対して、到達不能な現状の構造を無理に再現するテスト用の継ぎ目を本番コードへ追加する価値は低いと判断し、見送った。

## 影響

- `data-source-properties.ts` 側の集計ロジック（既存 3 カウントを 15 箇所以上で集計）は無変更のまま影響を受けない。`replaceRetainedSignedUrls` の戻り値の 3 カウントフィールドは `replacements` / `unsafe` 配列からの派生値として維持している。
- 裸 URL の置換範囲を将来広げる場合（commit 2 以降で検討）も、この ADR の「境界を証明できない限り置換しない」という原則は変えない前提で設計すること。
