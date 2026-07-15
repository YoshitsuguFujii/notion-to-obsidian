# ADR-002: Markdown API を主経路、Block API をフォールバックにする

- ステータス: 採用
- 日付: 2026-07-11

## コンテキスト

ページ本文を得る手段は 2 つ: (a) 公式 Markdown API `pages.retrieveMarkdown`（Enhanced Markdown）、(b) Block API で全ブロックを取得し自作レンダラーで Markdown 化。

## 決定

**Markdown API を主経路**とし、**Block API を補助・フォールバック**に限定する。

## 理由

- Markdown API は Notion 公式の変換仕様を利用でき、新ブロック対応に追従しやすく、自作レンダラーの保守範囲を最小化できる。
- ただし Markdown API 単独で完全とは仮定しない。以下では Block API を使う: `truncated` / `unknown_block_ids` / `<unknown>` 出力 / Markdown 未対応ブロック / 添付の安定識別に block ID が必要 / child page・child database の構造検出 / 内部リンク解決 / データソースのプロパティ取得 / ページ階層の正確な構築。

## unknown_block_ids / truncated の処理規約

1. `unknown_block_ids` を該当 block ID で公式 API から追加取得する。
2. 元 Markdown 内の対応位置を**一意かつ確実に特定できる場合のみ**マージする。
3. 位置を保証できない場合は、推測でページ末尾等へ挿入せず、対象ページ全体を **Block API レンダラーへフォールバック**する。
4. Block API でも完全変換できない場合は、可読なプレースホルダーを Markdown に残す。
5. 元ブロック JSON をサイドカーファイルに保存し、警告ログと同期サマリーに未対応項目を出す。
6. 追加取得が **404** の場合は「削除」とみなさず、権限不足/取得不能として警告する。

情報を黙って破棄することは禁止。追加取得した不明ブロックをページ末尾へ適当に付け足すことも禁止。

## 影響

- 変換ロジックに互換性のない変更を加える場合、`transform_version` を更新し、必要ページのみ再生成できるようにする（ADR で追跡）。
