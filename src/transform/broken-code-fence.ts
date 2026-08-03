import type { Code, List, RootContent } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

function isEmptyCodeWithLang(node: RootContent): node is Code {
  return (
    node.type === 'code' &&
    node.value === '' &&
    typeof node.lang === 'string' &&
    node.lang.length > 0
  );
}

function isBareCode(node: RootContent): node is Code {
  return (
    node.type === 'code' && (node.lang === null || node.lang === undefined)
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

// 閉じフェンス跡（孤立codeノード）は、CommonMark上「新たに開いたが閉じ
// られていないコードフェンス」として扱われるため、その直後に他の本文が
// 続く実データでは、次の実際のフェンスまたはEOFまでの本文をvalueへ
// 巻き込んでしまう（value===''にならない）。巻き込まれた本文を生
// Markdown文字列から取り出す。何も巻き込んでいない場合は空文字列を返す。
function extractTrailingContent(
  sourceText: string,
  endNode: Code,
): string | undefined {
  if (endNode.value === '') return '';
  const delimiterStart = offsetOf(endNode, 'start');
  const contentEnd = offsetOf(endNode, 'end');
  if (delimiterStart === undefined || contentEnd === undefined)
    return undefined;
  const afterDelimiterNewline = sourceText.indexOf('\n', delimiterStart);
  if (afterDelimiterNewline === -1 || afterDelimiterNewline >= contentEnd)
    return undefined;
  return sourceText.slice(afterDelimiterNewline + 1, contentEnd);
}

const fragmentProcessor = unified().use(remarkParse).use(remarkGfm);

// Notion Markdown APIは、番号付きリスト内のコードフェンスにおいて開始行
// だけをリスト継続に必要な分だけインデントし、本文行をインデントしない
// ことがある。CommonMarkのリスト継続判定は本文行のインデント不足を検出
// するとリストをそこで終了させるため、本文行は独立したparagraphへ、
// 閉じフェンス行は独立したcodeノード（lang無し）へ分裂する（崩壊シグ
// ネチャ: 空code+lang付き → 連続paragraph → 孤立code+lang無し）。生
// Markdown文字列から該当範囲を直接スライスし、元のインデント・空行を
// 保ったまま正しいcodeノードとして再構成する。閉じフェンス跡が後続本文
// を巻き込んでいる場合は、その本文を取り出して再parseし、修復した
// codeノードの直後へ差し戻す（後続本文自体は失わない）。シグネチャが
// 一部しか揃わない場合（意図的な空コードブロック等）は変換せず元のAST
// を維持する。
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
    if (paragraphCount === 0 || endNode === undefined || !isBareCode(endNode)) {
      result.push(node);
      index += 1;
      continue;
    }
    const rawContent = extractRawContent(sourceText, startNode, endNode);
    const trailing = extractTrailingContent(sourceText, endNode);
    if (rawContent === undefined || trailing === undefined) {
      result.push(node);
      index += 1;
      continue;
    }
    startNode.value = rawContent;
    result.push(node);
    if (trailing !== '') {
      const fragment = fragmentProcessor.parse(trailing);
      fragment.children = repairBrokenCodeFences(fragment.children, trailing);
      result.push(...fragment.children);
    }
    index = cursor + 1;
  }
  return result;
}
