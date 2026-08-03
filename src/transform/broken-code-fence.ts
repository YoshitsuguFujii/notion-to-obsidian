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

function offsetOf(node: Code, edge: 'start' | 'end'): number | undefined {
  return node.position?.[edge].offset;
}

// 崩壊した開始フェンス（閉じフェンスを持たない、単独行のみの不正な
// フェンス）は、CommonMark上そのフェンス行1行だけがcodeノードの
// position範囲になる（間に改行を含まない）。一方、開始・閉じフェンスが
// 揃った意図的な空コードブロックは、開始行から閉じ行までの複数行が
// position範囲になる。この違いで両者を区別し、後者（意図的な空コード
// ブロック）を崩壊シグネチャの開始・終了ノードとして誤検出しない。
// ノードが文書末尾の行に位置する場合、position範囲の末尾に区切りの
// 改行1つが含まれることがあるため、判定前にその1つだけを取り除く。
function isUnclosedFenceLine(node: Code, sourceText: string): boolean {
  const start = offsetOf(node, 'start');
  const end = offsetOf(node, 'end');
  if (start === undefined || end === undefined) return false;
  const slice = sourceText.slice(start, end).replace(/\n$/u, '');
  return !slice.includes('\n');
}

interface FenceMarker {
  char: '`' | '~';
  length: number;
}

const fenceMarkerLinePattern = /^ *(`{3,}|~{3,})([^\n]*)$/u;

// 生Markdown文字列上でoffsetが指す物理行を取り出し、その行がfence marker
// （`または~の3連続以上）で始まるかを判定する。開始フェンスは言語指定
// （info string）を持ちうるため許容し、終了候補は`requireNoInfoString`で
// info stringなしを必須にする（インデントコードブロックの誤認防止）。
// インデント幅は絶対値では判定しない（リスト内フェンスはコンテナ相対の
// インデントを持ち、番号付きリストの項目番号が2桁になるとマーカー幅が
// 4文字になるため絶対インデントは変動する。また、Notion Markdown APIは
// 崩壊時に閉じフェンス跡を本文行と同じ「インデントなし」で出力すること
// もあるため、開始フェンスとのインデント一致を要求すると、この典型的な
// パターンを誤って拒否してしまう）。
function fenceMarkerAtLineOf(
  sourceText: string,
  offset: number,
  { requireNoInfoString }: { requireNoInfoString: boolean },
): FenceMarker | undefined {
  const lineStart = sourceText.lastIndexOf('\n', offset - 1) + 1;
  const lineEndIndex = sourceText.indexOf('\n', offset);
  const lineEnd = lineEndIndex === -1 ? sourceText.length : lineEndIndex;
  const line = sourceText.slice(lineStart, lineEnd);
  const match = fenceMarkerLinePattern.exec(line);
  if (!match) return undefined;
  const marker = match[1]!;
  const infoString = match[2]!.trim();
  if (requireNoInfoString && infoString.length > 0) return undefined;
  return { char: marker[0] as '`' | '~', length: marker.length };
}

// 崩壊シグネチャの終了候補（isBareCodeで見つかったlang無しcodeノード）が、
// 本当に「崩壊した開始フェンスに対応する閉じフェンス跡」でありうるかを
// 検証する。次の条件をすべて満たさない限り、終了候補として扱わない：
// (1) 生Markdown文字列上で実際にfence marker行から始まり、info string
//     （言語指定）を持たない（4スペースインデントによるコードブロックを
//     誤って終了候補と認識しない）
// (2) fence文字種が開始ノードと一致する
// (3) fence marker長が開始ノード以上（CommonMarkの閉じフェンス条件）
//
// これらを満たしても「開始・終了が揃った独立した正常なコードブロック」を
// 誤って通過させる場合がある（例: 崩壊開始の直後に別の完結したコード
// ブロックが続くケース）。しかしその場合も、後続の`extractTrailingContent`
// が巻き込んだ内容を生Markdown文字列から取り出して再parseするため、内容
// 自体は失われない（段落として保持される。フォーマットは変わりうる）。
// 誤検出防止と情報保全のバランスから、内容が失われない安全側フォール
// バックがある以上、ここでは形式的な条件のみを検証する。
function isCollapsedFenceTerminator(
  startNode: Code,
  endNode: Code,
  sourceText: string,
): boolean {
  const startOffset = offsetOf(startNode, 'start');
  const endOffset = offsetOf(endNode, 'start');
  if (startOffset === undefined || endOffset === undefined) return false;
  const openMarker = fenceMarkerAtLineOf(sourceText, startOffset, {
    requireNoInfoString: false,
  });
  const closeMarker = fenceMarkerAtLineOf(sourceText, endOffset, {
    requireNoInfoString: true,
  });
  if (openMarker === undefined || closeMarker === undefined) return false;
  if (openMarker.char !== closeMarker.char) return false;
  return closeMarker.length >= openMarker.length;
}

// 崩壊した番号付きリスト内コードフェンスの開始ノード（空code+lang付き、
// かつ閉じフェンスを持たない単独行）を、最後のlistItemの最後の子として
// 持つ場合のみ返す。CommonMarkの仕様上、インデント不足で崩壊した行は
// リスト全体を終了させるため、崩壊が起こりうるのは最後のlistItemの
// 末尾に限られる。
function findTrailingBrokenCodeStart(
  list: List,
  sourceText: string,
): Code | undefined {
  if (!list.ordered) return undefined;
  const lastItem = list.children.at(-1);
  const lastChild = lastItem?.children.at(-1);
  if (
    lastChild === undefined ||
    !isEmptyCodeWithLang(lastChild) ||
    !isUnclosedFenceLine(lastChild, sourceText)
  )
    return undefined;
  return lastChild;
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
    const startNode = findTrailingBrokenCodeStart(node, sourceText);
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
      !isBareCode(endNode) ||
      !isCollapsedFenceTerminator(startNode, endNode, sourceText)
    ) {
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
        // remark-parseは通常どのような文字列に対しても例外を投げないため
        // 実行時には到達しない想定だが、中途半端に修復するより安全側に
        // 倒し、この崩壊リストは変換せず元のASTを維持するフォールバック
        // として残す。
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
