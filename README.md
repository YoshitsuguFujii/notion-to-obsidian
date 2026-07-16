# notion-to-obsidian

Notionの指定ルート配下を、Obsidian Vault内の管理対象ディレクトリへMarkdownとしてミラーするCLIです。階層、内部リンク、アセット、Data Source、改名、移動、削除を同期状態と照合します。

> [!WARNING]
> 現在は初期リリースです。実同期前にVaultとstate DBをバックアップし、必ず`plan`と`sync --dry-run`で変更内容を確認してください。

## クイックスタート

Notion Integration作成・Token取得・`config.yaml`の`notion.roots`/`obsidian.vault_path`/`obsidian.managed_path`設定が済んでいる前提の最短手順です。各ステップの詳細は後続の各セクションを参照してください。

```sh
cd notion-to-obsidian
cp .env.example .env
cp config.example.yaml config.yaml
npm install
npm run build
node --env-file=.env dist/cli/index.js doctor --config config.yaml
node --env-file=.env dist/cli/index.js plan --config config.yaml
node --env-file=.env dist/cli/index.js sync --config config.yaml --dry-run
node --env-file=.env dist/cli/index.js sync --config config.yaml
```

`.env`の`NOTION_TOKEN`と`config.yaml`の`notion.roots` / `obsidian.vault_path` / `obsidian.managed_path`は、`doctor`を実行する前に必ず編集してください（詳細は[Notionの準備](#notionの準備)と[Tokenとconfig](#tokenとconfig)を参照）。

## 運用原則

- **Notionが唯一の正本**です。同期方向はNotionからObsidianのみで、Notion APIへの書き込みは行いません。
- Obsidian側は読み取り専用ミラーとして扱ってください。管理対象Markdownを手作業で編集してもNotionへは反映されず、後続同期で上書き・移動される可能性があります。
- 本ツールは`obsidian.managed_path`配下の、管理マーカーとstate DBが一致するファイルだけを変更します。

## 必要要件

- Node.js 22以上
- npm
- macOSまたはNode.jsと`better-sqlite3`が動作するOS
- 既存のObsidian Vault
- 読み取り権限のNotion Internal Integration
- `better-sqlite3`のネイティブビルドが必要な環境ではXcode Command Line Tools: `xcode-select --install`

## インストール

```sh
git clone https://github.com/YoshitsuguFujii/notion-to-obsidian.git
cd notion-to-obsidian
npm install
npm run build
```

CLIはビルド後の`dist/cli/index.js`をNode.jsで実行します。以降の例はリポジトリルートから実行してください。

## Notionの準備

1. Notionの設定からInternal Integrationを作成します。
2. Integrationのcapabilityは読み取りだけにします。ページ・ブロックの更新やコメントの書込権限は不要です。
3. 同期したい各ルートページを開き、Connectionsから作成したIntegrationを追加します。子ページがIntegrationから読めることも確認します。
4. ルートページURLからpage IDを取得します。configにはUUID形式で記載します。

## Tokenとconfig

Tokenはconfigに書かず、`NOTION_TOKEN`環境変数だけから読み込みます。

```sh
cp .env.example .env
chmod 600 .env
cp config.example.yaml config.yaml
```

`.env`を編集し、実Tokenをローカルに設定します。`.env`はGitにcommitしないでください。

```dotenv
NOTION_TOKEN=<your-integration-token>
```

`config.yaml`で少なくとも次を変更します。

- `notion.roots[].page_id`: Notionルートのpage ID。各ページが属するルートは1つだけにしてください。同じpage IDを複数指定する、あるルートの配下にある別のページ（データベースの行ページを含む）をルートに指定する、といった重なりがあると、同じページを二重に処理してしまうため同期を停止します
- `notion.roots[].local_name`: ローカルのルート名
- `obsidian.vault_path`: 実在するVaultのパス
- `obsidian.managed_path`: Vault内の専用管理ディレクトリ。Vaultルート自体は指定できません

相対パスのstate DBは`config.yaml`の所在地を基準に解決されます。設定の全項目は[config.example.yaml](config.example.yaml)を参照してください。

## 初回実行

Node.jsの`--env-file`で`.env`を読み込みます。このツール自体は`.env`を自動読込しません。

### 1. doctor

```sh
node --env-file=.env dist/cli/index.js doctor --config config.yaml
```

Nodeバージョン、config、Tokenの有無、Vaultとmanaged pathの安全性、state DBとVaultの書込権限、symlink、Notion接続、ルート読取権限、APIバージョンを確認します。

### 2. plan

```sh
node --env-file=.env dist/cli/index.js plan --config config.yaml
```

CREATE / UPDATE / MOVE / TRASH / UNCHANGED / WARNINGなどの予定actionを、DB、ファイル、mtime、ディレクトリを変更せずに表示します。

### 3. dry-run

```sh
node --env-file=.env dist/cli/index.js sync --config config.yaml --dry-run
```

`plan`と同じく永続的な副作用なしでsyncフローを確認します。初回は必ずdoctor、plan、dry-runの順に成功させてください。

`plan` / `dry-run`は、grace runs到達予定のTRASHを含む予定actionを予測表示します。予測される退避が大量退避の安全弁（`maximum_trash_ratio` / `maximum_trash_count`）を超える場合は、`plan` / `dry-run`の時点で終了コード3（安全チェックでApply中止）を返して停止します。これは実同期の前に安全弁超過を警告する意図的な挙動です（`--allow-large-trash`で明示的に許可できます）。

### 4. 実同期

```sh
node --env-file=.env dist/cli/index.js sync --config config.yaml
```

同期はCensus → Plan → Applyの順で実行されます。完全なcensusと安全性検証に成功したactionだけを適用します。

## 同期オプション

```text
--dry-run                 永続的な変更を行わない
--full                    全ページを再処理する
--page-id <id>            1ページだけを同期する
--root <id>               1ルートだけを同期する
--verbose                 debugログを有効にする
--strict                  warning・一部失敗を非0終了にする
--allow-large-trash       大量退避のratio/count安全弁を明示的に解除する
-c, --config <path>       configパス（既定: config.yaml）
--json                    JSONで出力する
```

`--full`は保存済みページも再生成します。

```sh
node --env-file=.env dist/cli/index.js sync --config config.yaml --full
```

`--page-id`は対象ページだけの本文を取得・書込し、他ページの削除判定を行いません。データベースの行ページのIDも指定できます。パス計画にはルートからのフルツリーを使うため、親階層を保ったパスで安全に単独同期できます。このフルツリーを組み立てる過程で、対象ページ以外もルート配下の全データベースの行一覧を取得します（本文は取得しません）。単独同期でもこの分のAPI呼び出しが発生しますが、内部リンクの解決先と出力パスの重複検査を、全体同期と同じ精度で行うために必要です。

```sh
node --env-file=.env dist/cli/index.js sync --config config.yaml --page-id 00000000-0000-0000-0000-000000000000
```

## 状態確認

```sh
node --env-file=.env dist/cli/index.js status --config config.yaml
```

最新の同期runの開始・終了時刻、成否、action件数、resourceのactive / missing / tombstoned件数、warning、未退避のmissingを表示します。

```sh
node --env-file=.env dist/cli/index.js verify --config config.yaml
```

state DB、frontmatterの管理マーカー、ローカルパス、アセットの実在を照合します。管理対象外のMarkdownはエラーにせず`unmanaged`として報告します。

## 変更の反映

### 改名と移動

Notion page IDを安定識別子とし、タイトルや親が変わったときはMOVEとして新パスへ移します。空になった管理対象ディレクトリは整理し、管理対象外ファイルがあるディレクトリは残します。同名衝突時はpage IDの短縮値を付けた決定論的な別名を使います。

### 削除と`.trash`

Notionでゴミ箱へ移した、または同期範囲外になったページは、完全なcensusで`deletion_grace_runs`回連続して不在を確認した後に`<managed>/.trash/YYYY-MM-DD/<original-path>`へ退避します。完全削除は行いません。partial census、API障害、権限喪失、`--page-id`実行では他ページを退避しません。

復元は次の順で行います。

1. 同期の自動実行を停止し、Vaultとstate DBをバックアップします。
2. Notionでページを復元し、必要なルート配下とIntegrationの読取範囲に戻します。
3. `plan`と`sync --dry-run`で、`.trash`から期待パスへの復帰を確認します。
4. 実同期を実行し、`verify`で照合します。

Notionを復元できない緊急時は`.trash`から管理対象外の場所へMarkdownを**コピー**し、参照用に保全してください。state DBとの整合性を壊すため、`.trash`内のファイルを直接移動しないでください。

### アセット

Notionの画像・ファイルは`<managed>/_assets/<page-id>/`へ保存し、Markdownをローカル相対参照に書き換えます。Notion由来の添付は一般的なOffice文書、圧縮ファイル、動画、音声、テキスト形式を含む`notion_asset_allowed_content_types`と`notion_asset_allowed_extensions`で検査します。外部URLは既定でダウンロードせず、`download_external_assets: true`のときだけ、より限定的な`external_asset_allowed_content_types`と`external_asset_allowed_extensions`で検査して取得します。正規の形式を追加する場合は、対応するContent-Typeと拡張子を対象sourceの両許可リストへ追加してください。取得失敗、許可外形式、サイズ超過時はwarningを記録し、MarkdownのリモートURLを維持します。

**既知の制約:** 拒否されたNotion添付の署名付きリモートURLは将来失効する可能性があります。必要な形式が拒否された場合は、Notion側の許可リストへContent-Typeと拡張子を追加して、URLが有効なうちにページを再同期してください。

**既知の制約:** ローカルのアセットファイルが存在する場合、リモートの内容変更は検知しません。変更を反映したい場合は、対象の`_assets`内ファイルだけを削除し、`sync --page-id <page-id>`または通常のsyncを再実行してください。事前にVaultをバックアップし、削除後の`plan`で再取得対象を確認してください。

### Data Source

Notion API `2026-03-11`のData Sourceを専用の`_index.md`と行ページに変換します。title、rich_text、number、select、multi_select、status、date、people、files、checkbox、URL、email、phone、formula、relation、rollup、作成・編集時刻/ユーザー、unique IDを可読なfrontmatterへ変換します。同期対象のrelationはWikiLinkに解決します。

### 未対応ブロック

未知・未対応ブロックは黙って破棄しません。MarkdownにプレースホルダーとHTMLコメントを残し、元JSON相当のサイドカーとwarningで報告します。`--strict`ではwarningが一部失敗として非0終了になります。

## トラブルシューティング

### Integrationでルートを読めない

NotionのルートページにConnectionが追加されているか、`page_id`が正しいか、Integrationが読み取りcapabilityを持つかを確認し、doctorを再実行します。

### 強制終了後に同期できない

syncは`<state.database_path>.lock`で同時実行を防ぎます。通常終了時はlockを解除します。killや電源断でlockが残っても、記録PIDのprocessが存在しなければ次回syncがstale lockを自動削除します。記録PIDが実行中なら二重起動として終了コード5で停止します。

state DBに未完了runがある場合、次回syncはApply前にcrash recoveryを実行します。管理マーカーとDBを照合し、書込み・MOVE・TRASHの片側反映、重複、管理下の一時ファイルを復旧・整理します。管理対象外ファイルは変更しません。`--dry-run`では検出だけで修復しません。

### 画像・アセットが更新されない

既知のキャッシュ制約です。Vaultとstate DBをバックアップし、該当ページの`<managed>/_assets/<page-id>/`から対象ファイルを削除します。次に`plan`、`sync --page-id <page-id> --dry-run`、実同期の順で再取得を確認します。

### verifyが不整合を報告する

`issues`の`symlink`、`state_mismatch`、`orphan_managed_file`、`missing_file`、`missing_asset`を確認します。手動でDBを書き換えず、自動実行を止め、バックアップ後にplanとdry-runで復旧内容を確認してください。

## バックアップ

初回実同期前と設定変更前に、次を同じ時点でバックアップしてください。

- Obsidian Vault、特にmanaged directoryと`.trash`
- `state.database_path`のSQLite DBと同じbasenameの`-wal` / `-shm`がある場合はそれも含める
- `config.yaml`（Tokenは含まない）

整合したスナップショットにするため、syncとlaunchdジョブを停止してからコピーします。`.env`は通常のバックアップと分離し、暗号化して保管します。

## macOS launchd

[examples/launchd/com.example.notion-to-obsidian.plist](examples/launchd/com.example.notion-to-obsidian.plist)のプレースホルダーを絶対パスに書き換えて使います。例は30分ごと、macOSログイン時に同期します。1時間ごとにする場合は`StartInterval`を`3600`に変更します。

Tokenをplistに書かず、リポジトリ内または専用ディレクトリの`.env`を`chmod 600`で保護し、Node.jsの`--env-file=<absolute-path>`で読み込みます。より強い保護が必要な場合は、macOS Keychainから一時envファイルを生成するラッパーを利用し、ラッパーもplistから絶対パスで呼び出してください。

```sh
cp examples/launchd/com.example.notion-to-obsidian.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.example.notion-to-obsidian.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.notion-to-obsidian.plist
launchctl kickstart -k gui/$(id -u)/com.example.notion-to-obsidian
```

FileLockにより同時syncは行われません。前回実行が継続中なら後続は終了コード5で停止します。

停止・登録解除:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.notion-to-obsidian.plist
rm ~/Library/LaunchAgents/com.example.notion-to-obsidian.plist
```

## 状態DBとログ

state DBの位置は`state.database_path`で指定します。既定例の`./.state/notion-to-obsidian.db`はconfigファイルのディレクトリを基準にします。lockはそのパスに`.lock`を付けた場所に作られます。DBにはルート、resource、asset、warning、sync runを保存しますがTokenは保存しません。

ログは既定でstderrへ出力します。`logging.format` は`pretty | json`、`logging.level`は`debug | info | warn | error`です。`sync --verbose`は実行中のlevelをdebugにします。Token、Authorization、署名付きURLのqueryはマスクされます。launchdの例はstdoutとstderrを別ファイルへ保存します。ローテーションはOS側で設定してください。

## セキュリティ

運用前に[SECURITY.md](SECURITY.md)を読んでください。特にToken、managed path、外部アセット、バックアップの扱いを確認してください。CLIの終了コードは次のとおりです。

| Code | Meaning                               |
| ---: | ------------------------------------- |
|    0 | 成功                                  |
|    1 | config・認証・その他の重大エラー      |
|    2 | warningを含む一部失敗（`--strict`等） |
|    3 | 安全性検証によるApply中止             |
|    4 | `verify`不整合                        |
|    5 | 同時実行lock失敗                      |

## アンインストール

1. launchdを使っている場合は上記の`bootout`で先に停止します。
2. Vault、`.trash`、state DBをバックアップします。
3. リポジトリを削除します。
4. managed directory、state DB、`.trash`はユーザーデータのため自動削除されません。不要と判断した後に、バックアップを確認して手動で削除してください。

## ライセンス

このプロジェクトは[Apache License 2.0](LICENSE)の下で公開されています。

Copyright 2026 Yoshitsugu Fujii
