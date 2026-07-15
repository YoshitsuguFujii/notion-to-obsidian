# Security

## 脅威モデル

本ツールはNotion APIから読み取ったデータを、指定されたObsidian Vault内のmanaged directoryへ片方向に保存します。Notionへの書き込み、managed directory外の管理、完全削除はスコープ外です。

## Integration Token

- Integrationには読み取りcapabilityだけを付与します。Tokenが漏洩したときの影響を、Connectionを設定した読取範囲に限定するためです。
- Tokenは`NOTION_TOKEN`環境変数だけから読み込みます。`config.yaml`、plist、Markdown、state DB、コマンド履歴に書かないでください。
- `.env`をGit管理しないでください。`chmod 600 .env`とし、バックアップする場合は暗号化します。漏洩が疑われる場合はNotionでTokenを直ちにrotateします。
- ログはToken、`Authorization`、署名付きURLのqueryをredactします。ただし出力ファイル自体のアクセス権とローテーションは利用者が管理します。

## ローカル書込みの制限

- `obsidian.managed_path`は実在するVault配下の専用ディレクトリにします。Vaultルート、`/`、home、Vault外は拒否されます。
- パスを正規化し、`../`、絶対パス、不正文字、長すぎるセグメントを検査することでパストラバーサルを防ぎます。
- 書込み・MOVE・TRASHの各経路でパス階層のsymlinkを検査し、managed directory外へのescapeを拒否します。`verify`もsymlinkを不整合として報告します。
- frontmatterの`managed_by` / `notion_id`とstate DBのpathが一致するファイルだけを管理対象とします。管理対象外ファイルを上書き・移動・退避しません。

## 外部アセットとSSRF

`download_external_assets`は既定で`false`です。有効化すると、取得URLは次の検査を受けます。

- HTTP / HTTPS以外を拒否
- IPアドレスはglobal unicastだけを許可し、localhost、loopback、private、link-local、metadata service、documentation、transition、multicastを含むその他の範囲と判定不能な入力を拒否
- DNS解決後の全IPを検査
- redirectごとにURLとIPを再検査し、redirect回数を制限
- timeout、応答サイズ、Content-Type、拡張子を検査し、一時ファイルからatomicに確定

Content-Typeと拡張子はsource別の許可リストで検査します。Notion由来の添付は情報保全のため一般的な文書・圧縮・メディア形式を含む`notion_asset_allowed_content_types` / `notion_asset_allowed_extensions`を使います。外部URLは、より限定的な`external_asset_allowed_content_types` / `external_asset_allowed_extensions`を使います。必要な正規形式を追加するときは、対象sourceの両方の許可リストを更新してください。

拒否された添付はwarning付きでリモートURLのままMarkdownに残ります。Notionの署名付きURLは将来失効する可能性があるため、必要なNotion添付が拒否された場合は許可リストを更新し、URLが有効なうちに再同期してください。

**既知の制約:** DNS検査とNode.jsの実際のfetch内DNS解決の間にTOCTOUがあり、DNS rebindingを完全に防ぐsocketピン留めは実装していません。外部アセット取得を不要に有効化せず、信頼できないURLを含むNotionページでは無効のまま運用してください。

## 削除、dry-run、バックアップ

- API障害やpartial censusを削除とみなしません。完全なcensusでgrace runsを満たした管理対象だけを`.trash/YYYY-MM-DD/`へ退避します。完全削除はしません。
- 初回同期、config変更、ルート変更、大量退避を伴う作業の前に`plan`と`sync --dry-run`を使います。dry-runはDB、mtime、ログファイル、ディレクトリを作成・変更しません。
- Vault、`.trash`、SQLite DBとWAL/SHMを同期が停止した状態で定期バックアップします。`.trash`を自動消去しないでください。

## 依存パッケージ

- lockfileをcommitし、`npm install`時にバージョンを固定します。
- 定期的に`npm audit`を実行し、Notion SDK、HTTP、Markdown、YAML、SQLiteの変更をリリースノートとテストで確認します。
- 依存更新後は`npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`を実行します。

## 脆弱性の報告

TokenやVault内容を含む公開Issueを作成しないでください。報告先が用意されていない場合は、リポジトリ管理者に非公開の連絡手段を確認してください。
