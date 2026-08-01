// cells は Markdown 本文（HTML 主経路）または Notion の plain_text（Block API
// フォールバック経路）のいずれかで、既存の `\|` はどちらの経路でも「エスケープ
// 済みの literal `|`」として扱ってよい（前者は元々そういう意味、後者は
// renderRichText が `\` をエスケープしないため通常の入力に現れない）。
// バックスラッシュの個数の偶奇で判定し、既にエスケープ済みの `|` を
// 二重エスケープしない（`\*bold\*` 等、パイプ以外のエスケープには触れない）。
function escapeCell(text: string): string {
  return text
    .replace(/\r?\n/gu, '<br>')
    .replace(/(\\*)\|/gu, (_match, backslashes: string) =>
      backslashes.length % 2 === 0 ? `${backslashes}\\|` : `${backslashes}|`,
    );
}

export function buildMarkdownTableText(
  rows: readonly (readonly string[])[],
  hasHeaderRow: boolean,
): string {
  const columnCount = rows[0]?.length ?? 0;
  const headerCells: readonly string[] = hasHeaderRow
    ? (rows[0] ?? [])
    : Array.from({ length: columnCount }, () => '');
  const bodyRows = hasHeaderRow ? rows.slice(1) : rows;
  const toLine = (cells: readonly string[]): string =>
    `| ${cells.map(escapeCell).join(' | ')} |`;
  return [
    toLine(headerCells),
    toLine(headerCells.map(() => '---')),
    ...bodyRows.map(toLine),
  ].join('\n');
}
