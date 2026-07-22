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
- `obsidian.managed_path`配下の`_unsupported/`は、変換できないブロックを保全するサイドカーJSONのために本ツールが予約する領域です。この配下のファイルは、パス規約・state DBの記録・既存JSONの形式がすべて本ツールの生成物と一致する場合だけ更新対象とし、条件を満たさないファイル（手作業で置いたJSONなど）は変更せず同期を停止します。`_unsupported/`に手作業でファイルを置かないでください。
- `obsidian.managed_path`配下の`_assets/`は、ダウンロードした添付ファイルのために本ツールが予約する領域です。通常の再ダウンロード不要経路では、state DBに記録された正準パスの存在を確認してcached localを採用します。実際にダウンロードを試みた経路では、ダウンロード内容とハッシュが一致する場合だけ取り込み（adopt）、state DBが記録した旧ハッシュと一致する場合だけ新しい内容へ更新します。ダウンロードに失敗した場合も、旧ハッシュとsizeの両方が実ファイルと一致すると確認できたときだけcached localを維持し、それ以外はリモートURLを残します。所有を確認できない内容（手作業で置いたファイルなど）は変更せず同期を停止します。取り込んだファイルは以降、本ツールの更新対象になります。`_assets/`に手作業でファイルを置かないでください。

## 必要要件

- Node.js 22以上
- npm
- macOSまたはNode.jsと`better-sqlite3`が動作するOS。動作確認しているのはmacOSとLinuxです
- **アセット取得にはPOSIXの`O_NOFOLLOW`が必要です。** 利用できないOSとfilesystemでは、安全なfile openによる所有確認ができないためアセット取得をsafetyエラーで停止します。Node.jsが`fs.constants.O_NOFOLLOW`を提供しないWindowsが該当します。**Windowsでも、Markdownの同期・MOVE・TRASH・サイドカーの保全は従来どおり動作します。停止するのはアセット取得のみです**（アセットを含むページはリモートURLのまま同期されるのではなく、当該ページの同期がsafetyで停止します）。`O_NOFOLLOW`を利用できる環境へ移すか、アセットを含まない範囲を同期対象にしてください。なお`O_NOFOLLOW`のerrnoはPOSIX実装ごとに差があり、動作確認しているmacOSとLinux以外ではsymlinkの検出がsafetyではなくstorageエラーとして分類される可能性があります（いずれも停止するため、管理外ファイルを書き換えることはありません）
- 既存のObsidian Vault
- 読み取り権限のNotion Internal Integration
- `better-sqlite3`のネイティブビルドが必要な環境ではXcode Command Line Tools: `xcode-select --install`
- `better-sqlite3`はネイティブモジュールです。Node.jsのバージョンを変えた後は`npm rebuild better-sqlite3`を実行してください。実行しないと`NODE_MODULE_VERSION`の不一致でCLIが起動しません

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

- `notion.roots[].page_id`: Notionルートのpage ID。各ページが属するルートは1つだけにしてください。同じページを二重に処理しないため、ルートの重なりは次のように拒否されます。
  - 同じpage IDを複数指定した場合: 設定の読み込み時にエラーになります（すべてのコマンドが失敗します）
  - あるルートの配下にある別のページ（データベースの行ページを含む）をルートに指定した場合: Notionの階層を取得して初めて分かるため、`plan`と`sync`が停止します（`doctor` / `status` / `verify`は階層を取得しないので通ります）
- `notion.roots[].local_name`: ローカルのルート名
- `obsidian.vault_path`: 実在するVaultのパス
- `obsidian.managed_path`: Vault内の専用管理ディレクトリ。Vaultルート自体は指定できません

相対パスのstate DBは`config.yaml`の所在地を基準に解決されます。設定の全項目は[config.example.yaml](config.example.yaml)を参照してください。

## 初回実行

Node.jsの`--env-file`で`.env`を読み込みます。このツール自体は`.env`を自動読込しません。

`plan`と`sync`は対象ページ数に比例して時間がかかります。censusがページごとに子ブロックを再帰的に取得し、`notion.request_rate_per_second`（既定2.5）に律速されるためです。実測では31ページで20分以上、1ページあたり約40秒でした。**進捗表示はなく、完了まで標準出力は空のままです。**停止したように見えても中断せず、完了かエラーまで待ってください。動作中かどうかはプロセスのCPU時間が増えているかで判断できます。

### 1. doctor

```sh
node --env-file=.env dist/cli/index.js doctor --config config.yaml
```

Nodeバージョン、config、Tokenの有無、Vaultとmanaged pathの安全性、state DBとVaultの書込権限、symlink、Notion接続、ルート読取権限、APIバージョンを確認します。

### 2. plan

```sh
node --env-file=.env dist/cli/index.js plan --config config.yaml
```

CREATE / UPDATE / MOVE / TRASH / UNCHANGED / WARNINGなどの予定actionを、DB、ファイル、mtime、ディレクトリを変更せずに表示します。`sync --dry-run`では、保存先に既存ファイルがあり内容の判定をダウンロード後まで確定できないアセットを`ASSET_DEFERRED`として表示することがあります。これはダウンロード後に内容が一致すれば取り込み、一致しなければ停止する保留状態で、dry-runの成功がそのアセットのApply成功を保証しないことを示します。

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

### v1で保存された署名付きURLの修復

この手順は、v1のstate DBとMarkdownを引き続き使用する利用者だけが対象です。新規導入時や通常運用で`--full`を常用する必要はありません。transform versionは同期runのprovenanceとして記録されますが、保存済みページの移行済み判定には使われないため、versionの変化だけでは既存Markdownの修復完了を判断できません。

1. `sync --full --dry-run --strict`を実行し、`asset_signed_url_replaced`のWARNINGとUPDATE範囲を確認します。この移行では署名付きURLの検出WARNINGにより非0終了することが想定されます。安全エラーやpartial censusによる非0終了とは区別し、後者がある場合は実同期へ進まず原因を解消してください。
2. Vaultとstate DBを対でバックアップします。
3. `sync --full`を実行します。失敗または中断した場合は移行済みと判断せず、同じコマンドを再実行してください。
4. 通常の`sync`を実行し、対象ページがUNCHANGEDになることを確認します。
5. managed directory内のMarkdown（本文とfrontmatter）を、署名parameterを含む行の内容を表示しない方法で走査し、検出件数が0であることを確認します。`_unsupported/`のJSON sidecarはこの検査対象外です。

ロールバックは、修正版で再同期する前進修正を原則とします。v1バイナリへ戻すだけでは署名付きURLを再び保存するため、やむを得ず戻す場合は同じ時点のVaultとstate DBを対で復元してください。

`--page-id`は対象ページだけの本文を取得・書込し、他ページの削除判定を行いません。データベースの行ページのIDも指定できます。パス計画にはルートからのフルツリーを使うため、親階層を保ったパスで安全に単独同期できます。このフルツリーを組み立てる過程で、対象ページ以外もルート配下の全データベースの行一覧を取得します（本文は取得しません）。単独同期でもこの分のAPI呼び出しが発生しますが、内部リンクの解決先と出力パスの重複検査を、全体同期と同じ精度で行うために必要です。

```sh
node --env-file=.env dist/cli/index.js sync --config config.yaml --page-id 00000000-0000-0000-0000-000000000000
```

`--root`は指定したルートだけを同期し、本文取得・Plan / Apply・削除判定の対象も指定ルートに限定します。ただし、ルートの重複検査と内部リンクの解決先を全体同期と同じ精度で決めるため、全設定ルートをcensusし、Data Source行も展開します。単独同期でもこの分のNotion API呼び出しが発生しますが、出力パスとルートの所属関係を正しく保つために必要です。親子で重なるルートが設定されている場合は、`--root`実行でも同期を停止します。

```sh
node --env-file=.env dist/cli/index.js sync --config config.yaml --root 00000000-0000-0000-0000-000000000000
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

Notionの画像・ファイルは`<managed>/_assets/<page-id>/`へ保存し、Markdownをローカル相対参照に書き換えます。Notion由来の添付は一般的なOffice文書、圧縮ファイル、動画、音声、テキスト形式を含む`notion_asset_allowed_content_types`と`notion_asset_allowed_extensions`で検査します。外部URLは既定でダウンロードせず、`download_external_assets: true`のときだけ、より限定的な`external_asset_allowed_content_types`と`external_asset_allowed_extensions`で検査して取得します。正規の形式を追加する場合は、対応するContent-Typeと拡張子を対象sourceの両許可リストへ追加してください。取得失敗、許可外形式、サイズ超過時は、署名query・認証情報・ローカル絶対パスをマスクした原因をwarningへ記録します。実際の取得に失敗した場合は、state DBの旧hashとsizeに一致する通常ファイルだけをlocal fallbackとして採用し、確認できなければMarkdownのリモートURLを維持します。通常のno-download cache経路はhashを再計算せず、正準パスの存在確認だけでlocal URLを維持します。同じremote URLが複数のNotionブロックに対応するなど対応付けが曖昧なアセットは、warningを記録して取得せずremote URLを維持します。

Markdownへリモートを残す場合、Notion由来のURLは署名queryとfragmentを除いた形（origin+path）で保存します。Notionの添付URLは実行のたびに変わる署名付きの一時URLなので、完全なURLをそのまま残すと同じ内容でも本文が毎回変化し、取得に失敗し続けるページが毎回UPDATEになります。ダウンロード自体には完全な署名付きURLを使うため取得の成否は変わりません。**保存されたURLは署名を含まないため、そのままではブラウザで開けません**（署名付きURLも短時間で失効するため、いずれにせよ本文のURLは恒久的なリンクではありません）。外部URL（`download_external_assets: true`のとき）はユーザー由来で安定しているため、queryを含めて元のまま保存します。

署名原文を保存しない安全性を優先するため、Markdownのコードフェンス内とinline code内に例として書かれたNotion署名付きURLも同じ規則で置換します。置換の発生はURLを含まないWARNINGと件数で確認できます。

取得に失敗したアセットは、state DBに所有情報（旧hash・size・正準パス）を残したまま「未検証」として記録します。未検証のアセットは、ローカルにファイルが残っていても通常の同期ではlocal参照へ戻しません。**再取得はページが変更されたとき、または`sync --full`のときに行います**（毎回の同期で自動再試行はしません。取得できない状態が続いても外部サービスへ繰り返し要求しないためです）。再取得に成功すると通常のcachedへ戻り、本文もlocal参照へ戻ります。取得計画に載った候補同士で同じremote URLが異なるlocal pathへ対応する場合だけ、安全性検証でPlanを停止します。

**既知の制約:** 拒否されたNotion添付の署名付きリモートURLは将来失効する可能性があります。必要な形式が拒否された場合は、Notion側の許可リストへContent-Typeと拡張子を追加して、URLが有効なうちにページを再同期してください。

**既知の制約:** ローカルのアセットファイルが存在する場合、リモートの内容変更は検知しません。変更を反映したい場合は、対象の`_assets`内ファイルだけを削除し、`sync --page-id <page-id>`または通常のsyncを再実行してください。事前にVaultをバックアップし、削除後の`plan`で再取得対象を確認してください。

**既知の制約:** アセットの所有確認とダウンロード失敗時のlocal fallbackは、`O_NOFOLLOW | O_NONBLOCK`で開いた同一file handleから内容を読み、読取前後のidentityと読取直後のpathを照合して競合窓を縮小します。adoptでは最終照合からstate DB保存まで、managed updateでは最終照合から`rename`までに差し替えの窓が残ります。同じsizeとmetadataへ復元された同一inodeの変更も検出できないため、完全なTOCTOU防止ではありません。従来は`O_NOFOLLOW`を利用できない環境でもアセット取得を試行しましたが、安全なfile openを保証できない環境を新たにsafety停止の対象とする意図的な互換差分があります。

**互換上の注意（本文URL形式の変更）:** 従来はMarkdownへリモートを残す際にNotionの完全な署名付きURL（query・fragmentを含む）を保存していましたが、現在は本文とfrontmatterの最終出力を検査し、queryとfragmentを除いた形で保存します。ローカルへ取り込み済みのアセット、外部由来と判定できるURL、Markdownの他の内容、ダウンロード時に使うURLはいずれも影響を受けません。v1で保存済みのMarkdownは、前述の一回限りの`sync --full`手順で修復してください。

**既知の制約:** 本文URLの安定化は、Notionの添付URLのうちqueryとfragmentだけが変わることを前提にしています。origin+path自体が変わる場合は本文が毎回変化し、取得に失敗し続けるページのUPDATEが残ります。また、URLのパスでブロックを特定できない曖昧なアセット（ファイル名や出現位置での対応付けが複数ブロックに一致するもの）は、外部URLと区別できないため安定化の対象外です。

### Data Source

Notion API `2026-03-11`のData Sourceを専用の`_index.md`と行ページに変換します。title、rich_text、number、select、multi_select、status、date、people、files、checkbox、URL、email、phone、formula、relation、rollup、作成・編集時刻/ユーザー、unique IDを可読なfrontmatterへ変換します。同期対象のrelationはWikiLinkに解決します。

### 未対応ブロック

未知・未対応ブロックは黙って破棄しません。MarkdownにプレースホルダーとHTMLコメントを残し、元JSON相当のサイドカーとwarningで報告します。`--strict`ではwarningが一部失敗として非0終了になります。

## トラブルシューティング

### Integrationでルートを読めない

この状態でdoctorを実行すると、`notion_connection`は`Notion network request failed`、`root_read_permission`は`One or more configured roots are not readable`と表示します。前者は回線やプロキシの問題に見えますが、実際のNotion APIエラーは`object_not_found`で、**ルートページがIntegrationに共有されていない**ことを示します。Tokenを作成しただけではページを読めず、ページ側でConnectionを追加する必要があります。

NotionのルートページにConnectionが追加されているか、`page_id`が正しいか、Integrationが読み取りcapabilityを持つかを確認し、doctorを再実行します。

### 強制終了後に同期できない

syncは`<state.database_path>.lock`で同時実行を防ぎます。通常終了時はlockを解除します。killや電源断でlockが残っても、記録PIDのprocessが存在しなければ次回syncがstale lockを自動削除します。記録PIDが実行中なら二重起動として終了コード5で停止します。

state DBに未完了runがある場合、次回syncはApply前にcrash recoveryを実行します。管理マーカーとDBを照合し、書込み・MOVE・TRASHの片側反映、重複、管理下の一時ファイルを復旧・整理します。管理対象外ファイルは変更しません。`--dry-run`では検出だけで修復しません。

MarkdownのCREATE中に強制終了すると、管理マーカーがあるもののstate DBに記録がない正規Markdown、state DBに記録がない一時ファイル、state DBに記録がある一時ファイルが残ることがあります。いずれも自動回復しません。最初の正規Markdownは次回syncで管理対象外と判定され、同期が停止します。state DBに記録がない一時ファイルはcrash recoveryの対象外です。正常終了後に残ったstate DBに記録がある一時ファイルも、未完了runがないため通常の次回syncでは自動回収されません。また、state DBの喪失・古いバックアップからの復元・Markdownだけをmanaged directoryの外へ退避した手動復旧の後には、`_unsupported/`配下にstate DBの記録がないサイドカーだけが残ることがあります。これも自動回復せず、次回syncで管理対象外と判定して同期が停止します。

復旧時はlaunchdなどの自動実行を止め、Vaultとstate DBをバックアップしてから`verify`を実行します。state DBに記録がない正規Markdownと一時ファイルは削除せずmanaged directoryの外へ退避し、`plan`、`sync --dry-run`、通常の`sync`の順で再作成内容を確認して、正規Markdownとstate DBを再確立します。state DBに記録がある一時ファイルは、正規Markdownの管理マーカーとstate DBの`local_path`が一致することを確認してから、一時ファイルだけをmanaged directoryの外へ退避してください。state DBの記録がない`_unsupported/`配下のサイドカーも、削除せずmanaged directoryの外へ退避してから再同期してください。`_assets/`配下のアセットも、保存内容がダウンロード内容と一致しないために停止した場合は、削除せずmanaged directoryの外へ退避してから再同期してください（本ツールが以前に保存した内容と一致するファイルは再同期で取り込まれます）。管理マーカー・内容・Notion page IDの一致だけを根拠にstate DBを手編集したり、既存ファイルを管理対象として取り込んだりしないでください。

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

VaultそのものをGitリポジトリにしておくと、同期結果を`git diff`で全件確認でき、意図しない変更があれば元に戻せます。初回同期や移行手順のように差分が大きくなる場面で有効です。この運用では、state DBをVaultの外に置くか`.gitignore`で除外してください。

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
