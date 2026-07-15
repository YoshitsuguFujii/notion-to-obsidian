# AGENTS.md

このファイルは、本リポジトリで作業するすべての AI エージェント（Codex / Claude Code / GitHub Copilot 等）と人間の開発者が従う共通ルールである。Claude Code は `CLAUDE.md` 経由でこのファイルを読み込む。

## 公開リポジトリの取り扱い（最重要）

**本リポジトリは公開（public）である。** 以下のセンシティブな内容を、コミット・ドキュメント・コメント・コミットメッセージのいずれにも含めてはならない。

- 個人情報（氏名・メールアドレス等。ただし LICENSE / README の著作権表記は除く）
- ローカルの絶対パス（`/Users/<name>/...`、`/home/<name>/...` 等）
- 個人の Obsidian Vault 名、同期対象の実ページ ID、実ディレクトリ構成
- Notion トークン・API キー・その他の秘密情報

実環境の設定（`config.yaml` / `.env` 等）や実行状態（`*.db` / `.state/` 等）、エージェントのローカル状態（`.steering/` / `.codex/` / `.claude/settings.local.json` 等）は `.gitignore` で除外する。共有すべきはルール・設計・サンプル（`*.example`）のみ。過去に steering 経由でローカル絶対パス・Vault 名が git 履歴へ漏れ、リポジトリの削除・再作成が必要になった事故がある。コミット前に `git status` / `git diff` で混入を確認すること。

## 目的と正本

`notion-to-obsidian`は、Notionの指定ルート配下をObsidian Vault内のmanaged directoryへMarkdownとしてミラーするTypeScript CLIである。**Notionが唯一の正本**で、Obsidianは読み取り専用ミラーとして扱う。Notion APIへのcreate / update / delete / archive等の書き込みは禁止する。

仕様の正本（すべて公開リポジトリに含まれる）:

- アーキテクチャ: `docs/architecture.md`
- 意思決定: `docs/adr/`
- Notion API仕様の調査結果: `docs/notion-api-findings.md`

## 開発コマンド

```sh
npm install
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run coverage
```

CLI確認:

```sh
node --env-file=.env dist/cli/index.js doctor --config config.yaml
node --env-file=.env dist/cli/index.js plan --config config.yaml
node --env-file=.env dist/cli/index.js sync --config config.yaml --dry-run
node --env-file=.env dist/cli/index.js status --config config.yaml
node --env-file=.env dist/cli/index.js verify --config config.yaml
```

実Tokenまたは実Vaultを使うコマンドは、ユーザーの明示的な許可なしに実行しない。

## アーキテクチャ

同期はCensus → Plan → Applyの3段である。

- `src/notion/`: 公式Notion SDK、再帰census、Markdown / Block API、Data Source
- `src/domain/`: resourceとパス計画
- `src/transform/`: remark ASTによるMarkdown、WikiLink、frontmatter、Data Source変換
- `src/assets/`: block対応付け、キャッシュ、HTTP取得、SSRF検査
- `src/sync/`: 差分、削除安全弁、plan検証、crash recovery、orchestrator
- `src/filesystem/`: atomic write、MOVE、TRASH、managed marker、safe path
- `src/storage/`: `StateStore`とbetter-sqlite3、migration
- `src/commands/` / `src/cli/`: doctor / plan / sync / status / verifyと終了コード

外部境界は`NotionClient` / `FileSystem` / `HttpDownloader` / `StateStore`等のinterface背後に置く。テストは公開された戻り値、状態、ファイル結果を検証し、内部呼出回数に過度に依存しない。

## 安全不変条件

1. Notionへ一切書き込まない。
2. managed directory内で、markerとDBにより管理下と確認できるファイルだけを変更する。managed directory外やunmanagedファイルは変更・退避しない。
3. API失敗を削除と誤認しない。partial census / Search-incompleteでTRASHを生成しない。
4. Notion page IDを唯一の安定識別子にする。
5. 親の更新有無にかかわらず子を探索する。
6. 改名と階層移動はMOVEとし、管理下の旧ファイル・空ディレクトリを残さない。
7. 削除はgrace runs後に`.trash`へ退避し、完全削除しない。
8. unknown / unsupportedを黙って捨てず、placeholder、サイドカー、warningで保全する。
9. dry-runはDB、mtime、ログファイル、ディレクトリを作成・変更しない。
10. 同一入力の2回目はcontentとmtimeを変更しない。
11. Tokenをlog、DB、frontmatter、例外、fixture、CLI出力へ漏らさない。署名付きURLのqueryをmaskする。
12. パストラバーサルとsymlink escapeでmanaged directory外へ書かない。

## 変更手順

### 新しいNotionブロック対応

1. 公式API `2026-03-11`の応答とMarkdown API出力を確認する。
2. Markdown主経路で取得できる場合は`src/transform/`のremark AST変換を追加する。code / inline code / URL / HTML / 数式を正規表現の全体置換で壊さない。
3. Markdownで保全できない場合は`src/transform/fallback-block-renderer.ts`へBlock API変換を追加する。対応不能時のplaceholderとsidecarは残す。
4. golden / fixtureと、対応・フォールバック・情報保全のテストを先に追加する。変換互換性が変わる場合は`transform_version`とADRの更新要否を検討する。
5. 変換処理をパイプラインへ追加する際は、remarkで複数回parse→stringify（round-trip）を繰り返すとWikiLink等のObsidian独自の文字列構文が破壊される（`[[path|alias]]`が`\[\[path\|alias\]\]`へエスケープされる）ことに注意する。パイプライン順序は「1. Enhanced Markdown変換（AST処理）→ 2. アセット等のAST後処理 → 3. 最終段階での文字列置換（WikiLink解決等）」とし、文字列置換が完了した本文を再度remarkに渡さない。remark採用の背景は`docs/adr/006-use-remark-for-enhanced-markdown.md`を参照。

### DB migration

1. `src/storage/migrations/` に既存番号の次の連番でmigrationを追加する。既存migrationを書き換えない。
2. migrationはtransaction可能で、既存DBから安全に移行できる形にする。`foreign_keys=ON`、WAL、`busy_timeout`の不変条件を維持する。
3. migration runnerの一覧へ追加し、新規DB、旧バージョンからの更新、再実行のテストを先に書く。
4. SQLと`better-sqlite3`は`src/storage/`外へ漏らさず、必要な操作は`StateStore`境界へ追加する。

### 削除・MOVE・crash recovery

- `src/sync/deletion-guard.ts`、`plan-validator.ts`、`src/filesystem/trash.ts`、`management-marker.ts`、`reconcile-crash.ts`の契約を同時に追う。
- partial census、`--page-id`、grace runs、large trash ratio/count、unmanaged衝突、symlink、クラッシュの各安全弁テストを省略しない。
- filesystemを先に確定し、成功後にDBをtransaction更新する順序を崩さない。失敗ページを同期済みにしない。

## 既知の制約

- ローカルアセットが存在する間は、remote metadataの内容変更を検知しない。再取得には対象アセットを削除し、dry-run後に再同期する。
- 外部アセットは既定無効。有効時はDNS検査とfetchの間にDNS rebinding TOCTOUが残る。
- Enhanced Markdownの変換結果はremarkのstringify仕様に依存し、依存更新でMarkdown差分が出る可能性がある。
