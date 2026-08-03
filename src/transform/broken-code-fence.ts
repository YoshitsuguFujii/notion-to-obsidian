import type { Code, List, RootContent } from 'mdast';

function isEmptyCodeWithLang(node: RootContent): node is Code {
  return (
    node.type === 'code' &&
    node.value === '' &&
    typeof node.lang === 'string' &&
    node.lang.length > 0
  );
}

function isIsolatedEmptyCode(node: RootContent): node is Code {
  return (
    node.type === 'code' &&
    node.value === '' &&
    (node.lang === null || node.lang === undefined)
  );
}

// 崩壊した番号付きリスト内コードフェンスの開始ノード（空code+lang付き）を、
// 最後のlistItemの最後の子として持つ場合のみ返す。CommonMarkの仕様上、
// インデント不足で崩壊した行はリスト全体を終了させるため、崩壊が起こり
// うるのは最後のlistItemの末尾に限られる。
function findTrailingBrokenCodeStart(list: List): Code | undefined {
  if (!list.ordered) return undefined;
  const lastItem = list.children.at(-1);
  const lastChild = lastItem?.children.at(-1);
  if (lastChild === undefined || !isEmptyCodeWithLang(lastChild))
    return undefined;
  return lastChild;
}

function offsetOf(node: Code, edge: 'start' | 'end'): number | undefined {
  return node.position?.[edge].offset;
}

// 開始・終了フェンスに挟まれた生文字列から、フェンス行自体（開始側の
// 改行、終了側の改行とインデント）だけを取り除き、コード本文を取り出す。
// 本文行の元のインデント・空行はそのまま保持する（design.mdの安全不変
// 条件：崩壊時に生じていたインデント・空行を保つ）。
function extractRawContent(
  sourceText: string,
  startNode: Code,
  endNode: Code,
): string | undefined {
  const contentStart = offsetOf(startNode, 'end');
  const contentEnd = offsetOf(endNode, 'start');
  if (contentStart === undefined || contentEnd === undefined) return undefined;
  if (contentEnd < contentStart) return undefined;
  const between = sourceText.slice(contentStart, contentEnd);
  const withoutLeadingNewline = between.replace(/^\r?\n/u, '');
  return withoutLeadingNewline.replace(/\r?\n[ \t]*$/u, '');
}

// Notion Markdown APIは、番号付きリスト内のコードフェンスにおいて開始行
// だけをリスト継続に必要な分だけインデントし、本文行をインデントしない
// ことがある。CommonMarkのリスト継続判定は本文行のインデント不足を検出
// するとリストをそこで終了させるため、本文行は独立したparagraphへ、
// 閉じフェンス行は独立した空codeノードへ分裂する（崩壊シグネチャ: 空
// code+lang付き → 連続paragraph → 孤立空code+lang無し）。生Markdown
// 文字列から該当範囲を直接スライスし、元のインデント・空行を保ったまま
// 正しいcodeノードとして再構成する。シグネチャが一部しか揃わない場合
// （意図的な空コードブロック等）は変換せず元のASTを維持する。
export function repairBrokenCodeFences(
  children: RootContent[],
  sourceText: string,
): RootContent[] {
  const result: RootContent[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index]!;
    if (node.type !== 'list') {
      result.push(node);
      index += 1;
      continue;
    }
    const startNode = findTrailingBrokenCodeStart(node);
    if (startNode === undefined) {
      result.push(node);
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (children[cursor]?.type === 'paragraph') cursor += 1;
    const paragraphCount = cursor - (index + 1);
    const endNode = children[cursor];
    if (
      paragraphCount === 0 ||
      endNode === undefined ||
      !isIsolatedEmptyCode(endNode)
    ) {
      result.push(node);
      index += 1;
      continue;
    }
    const rawContent = extractRawContent(sourceText, startNode, endNode);
    if (rawContent === undefined) {
      result.push(node);
      index += 1;
      continue;
    }
    startNode.value = rawContent;
    result.push(node);
    index = cursor + 1;
  }
  return result;
}
