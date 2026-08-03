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
// 崩壊時に生じていた本文行の元のインデント・空行は、正規化・trimせず
// そのまま保持する。
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

interface MaybePositioned {
  position?: unknown;
  children?: RootContent[];
}

// 差し戻すfragmentのノードはtrailing文字列基準のoffsetを持つ。呼び出し元
// のtransformParentはこの後、元文書のsourceText基準でノードを再帰処理
// するため、position情報を保持したままにすると、fragment内部（さらに
// ネストしたlistItem等）で崩壊コードフェンスの検出が働いた場合に誤った
// offsetでsourceTextをスライスし、無関係な文字列をコード本文として書き
// 込みかねない。以後の処理がoffsetに依存する関数はoffset未定義を安全側
// フォールバックとして扱う設計のため、position自体を再帰的に削除して
// おけば以後は必ずフォールバックする。
function stripPositionsDeep(node: MaybePositioned): void {
  delete node.position;
  for (const child of node.children ?? []) stripPositionsDeep(child);
}

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
    let fragmentChildren: RootContent[] = [];
    if (trailing !== '') {
      try {
        const fragment = fragmentProcessor.parse(trailing);
        fragment.children = repairBrokenCodeFences(fragment.children, trailing);
        for (const fragmentChild of fragment.children)
          stripPositionsDeep(fragmentChild);
        fragmentChildren = fragment.children;
      } catch {
        // 巻き込まれた本文をparseできない場合、中途半端に修復するより
        // 安全側に倒し、この崩壊リストは変換せず元のASTを維持する。
        result.push(node);
        index += 1;
        continue;
      }
    }
    startNode.value = rawContent;
    result.push(node);
    result.push(...fragmentChildren);
    index = cursor + 1;
  }
  return result;
}
