# 最終検証レポート

実行日: 2026-07-12

## 結論

一時Vault、ファイルSQLite DB、モック`NotionClient`を使った19シナリオのE2Eはすべて成功した。WikiLink escapeとunsupported sidecar未永続化をTDDで修正し、アセット併存時、dry-run、UNCHANGED時の欠落sidecar再生成も回帰テストで確認した。

## E2E 19シナリオ

| # | 結果 | 検証内容 |
|---:|---|---|
| 1 | PASS | 初回CREATE、Markdown、DB resource |
| 2 | PASS | 2回目UNCHANGED、content / mtime不変 |
| 3 | PASS | 子のみUPDATE、親mtime不変 |
| 4 | PASS | 親`last_edited_time`不変で子更新を検出 |
| 5 | PASS | タイトル変更をMOVE |
| 6 | PASS | 改名後の旧ファイル不在 |
| 7 | PASS | 別の親へMOVE |
| 8 | PASS | 空の旧child directoryを除去 |
| 9 | PASS | 同名ページの決定論的ID suffix |
| 10 | PASS | Notion trashをTRASH actionとtombstoneへ反映 |
| 11 | PASS | 2 grace runs後に`.trash/2026-07-12/`へ退避 |
| 12 | PASS | Root API失敗をpartialとし、TRASHを生成しない |
| 13 | PASS | アセットを取得し相対参照へ変換、署名queryをMarkdownから除去 |
| 14 | PASS | アセット処理後に内部リンクをWikiLink化し、`[[path|alias]]`を維持 |
| 15 | PASS | 対象外Notion URLを外部リンクのまま維持 |
| 16 | PASS | placeholder / HTML commentと`_unsupported/<page-id>/<block-id>.json`の元payloadを保存 |
| 17 | PASS | dry-runでmanaged directory、resource、runを作成しない |
| 18 | PASS | managed directory内の手書きMarkdownのcontent / mtime不変 |
| 19 | PASS | unfinished run検出後のcrash recoveryで管理下tmpを除去し再同期 |

## 検証手順1〜10

1. `npm run format:check`: PASS。Prettier差分なし。
2. `npm run lint`: PASS。ESLint警告・エラーなし。
3. `npm run typecheck`: PASS。TypeScriptエラーなし。
4. `npm test`: PASS。41 files、320 passed。expected failureなし。
5. `npm run test:e2e`: PASS。1 file、22 passed。E2E 19シナリオ、sidecarのdry-run / 欠落復旧、運用フローを含む。
   `npm run test:integration`: PASS。専用integration testは0 filesで、`--passWithNoTests`により正常終了。
6. `npm run coverage`: PASS。Statements 87.11% (1805/2072)、Branches 77.29% (1362/1762)、Functions 87.53% (351/401)、Lines 89.57% (1684/1880)。
7. `npm audit --json`: PASS。info / low / moderate / high / criticalはすべて0、合計0件。監査依存305。
8. `npm run build`: PASS。`tsc -p tsconfig.build.json`成功。
9. `node dist/cli/index.js --help` / `sync --help`: PASS。doctor / plan / sync / status / verifyと全sync optionを表示。実Token・実Vaultは不使用。
10. 一時Vault運用フロー: PASS。実`runDoctor`、plan相当のdry-run、sync dry-run、実sync、2回目syncを同一ハーネスで実行。2回目はUNCHANGEDでcontent / mtime不変。

## AC-1〜AC-14トレース

| AC | 結果 | 根拠 |
|---|---|---|
| AC-1 | PASS | format / lint / typecheck / unit / E2E / buildがすべて成功 |
| AC-2 | PASS | E2Eはモック`NotionClient`のみ。実API接続なし |
| AC-3 | PASS | `NotionClient`は読取り操作のみ、E2Eモックもretrieve / list / query / searchのみ |
| AC-4 | PASS | E2E #17と運用フローでdry-runのDB / file / directory不変 |
| AC-5 | PASS | E2E #3 / #4 |
| AC-6 | PASS | E2E #5〜#9 |
| AC-7 | PASS | E2E #10〜#12 |
| AC-8 | PASS | E2E #13〜#15でasset、WikiLink、対象外linkを検証 |
| AC-9 | PASS | E2E #16のplaceholder / sidecarと#18のunmanaged保護を検証 |
| AC-10 | PASS | E2E #2と運用フロー |
| AC-11 | PASS | `tests/security-output.test.ts`のToken / Authorization / URL query redaction |
| AC-12 | PASS | `README.md`とlaunchd例、Phase 9検証 |
| AC-13 | PASS | `tests/safe-path.test.ts`とplan / write / move / trashのsymlink検証 |
| AC-14 | PASS | `tests/asset-security.test.ts`のscheme / IP / DNS / redirect検証 |

## 保証方法

- read-only: `NotionClient`の公開境界をretrieve / list / query / searchに限定し、Notion SDKの書込みAPIを同期経路に持たない。
- dry-run: orchestratorでrun、filesystem、DB更新を分岐し、E2E #17で実Vault / DBの不変を検証。
- managed directory限定: `joinManagedPath`、symlink検証、frontmatterとDBのmanagement marker一致をwrite / MOVE / TRASHで要求。
- partial census: `status=partial` / `deletionAllowed=false`でmissing / TRASHを停止。E2E #12で検証。
- trash: complete census、grace runs、ratio / count検証後にだけ`.trash/<date>/`へatomic MOVE。E2E #10 / #11で検証。
- Token redaction: loggerとerror境界でToken / Authorization / 署名queryをマスクし、unit testで検証。
- SSRF: HTTP(S)のみを許可し、予約IP、DNS解決後IP、redirectごとの再検証をunit testで検証。

## 初回実行手順

```sh
cp .env.example .env
cp config.example.yaml config.yaml
npm install
npm run build
node --env-file=.env dist/cli/index.js doctor --config config.yaml
node --env-file=.env dist/cli/index.js plan --config config.yaml
node --env-file=.env dist/cli/index.js sync --config config.yaml --dry-run
node --env-file=.env dist/cli/index.js sync --config config.yaml
```

## 未達項目

なし。
