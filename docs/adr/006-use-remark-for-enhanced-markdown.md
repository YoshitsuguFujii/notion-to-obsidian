# ADR-006: Enhanced Markdown を remark AST で変換する

- ステータス: 採用
- 日付: 2026-07-11

## コンテキスト

Notion の Enhanced Markdown には標準 Markdown に加え、callout、columns、toggle、HTML table が含まれる。code block、inline code、URL、HTML、数式を壊さずに Obsidian 向けへ変換する必要がある。

## 決定

`unified`、`remark-parse`、`remark-gfm`、`remark-stringify` を使用する。標準 Markdown は mdast の parse/stringify に委ね、Notion 固有の callout と columns は remark が生成した HTML node だけを限定的に変換する。toggle と未知 HTML は情報保持のためそのまま残す。

Markdown API の `<unknown>` 位置確認にも remark AST を使い、code block と inline code 内の同名文字列を placeholder と誤認しない。

## 理由

- Markdown 全体への正規表現置換を避け、構文境界を保てる。
- GFM table、task list、strikethrough を既存実装で扱える。
- code と inline code を値変換の対象外にできる。
- D-10 の依存数と保守性の条件を満たす。

## 影響

- remark の stringify 結果を変える更新は Markdown 差分を生む可能性があるため、依存更新時に golden test を確認する。
- Phase 4 の内部リンク変換も mdast node を対象とし、code と inline code を除外する。
