# ADR-001: 公式 Notion SDK を使用する

- ステータス: 採用
- 日付: 2026-07-11

## コンテキスト

Notion コンテンツを取得する手段として、公式 SDK・自作 HTTP クライアント・非公式ライブラリ・スクレイピングが考えられる。

## 決定

公式 SDK **`@notionhq/client`** を、API バージョン **`2026-03-11`** で使用する。コンストラクタで `notionVersion: '2026-03-11'` を指定する。

## 理由

- 公式の型定義と型ガードを利用でき、`2026-03-11` の Markdown API / Data Source API に追従しやすい。
- 非公式クライアント・スクレイピング・内部 API・Puppeteer/Playwright による画面操作は仕様で明確に禁止されており、保守性・規約順守の観点でも避ける。
- 依存を最小化する方針に合致する。

## 影響

- SDK のバージョン更新時は Markdown API / Data Source API の互換性を確認する。
- ユニットテストは SDK を直接呼ばず、`NotionClient` interface のモックを使う（`src/notion/client.ts`）。実 API テストは `NOTION_TEST_TOKEN` 設定時のみの任意 integration test とする。
