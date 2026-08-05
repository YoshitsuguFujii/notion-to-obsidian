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

function offsetOf(
  node: RootContent,
  edge: 'start' | 'end',
): number | undefined {
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
  indent: string;
}

const fenceMarkerLinePattern = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/u;

// インデント文字列の実効幅を計算する。タブは4スペース相当として扱う
// （CommonMarkが定義する「次のタブストップまで」という絶対位置依存の
// 展開ルールを、行頭からのみのスコープに簡略化したもの。行頭からの
// 計算のみなので実務上のズレは生じない）。Notion Markdown APIは番号
// 付きリスト内のコードフェンス開始行を、リスト継続に必要な分だけタブで
// インデントして出力することがあるため、maxIndent判定（CommonMarkの
// fenced codeとして成立する0〜3相当）はこの実効幅で行い、タブ1文字を
// 単純に1文字としてカウントして実効インデント幅を過小評価しない。
function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width += char === '\t' ? 4 : 1;
  return width;
}

// 生Markdown文字列上でoffsetが指す物理行を取り出し、その行がfence marker
// （`または~の3連続以上）で始まるかを判定する。開始フェンスは言語指定
// （info string）を持ちうるため許容し、終了候補は`requireNoInfoString`で
// info stringなしを必須にする（インデントコードブロックの誤認防止）。
// 開始フェンスのインデント幅には上限を設けない（リスト内フェンスは
// コンテナ相対のインデントを持ち、番号付きリストの項目番号が2桁になると
// マーカー幅が4文字になるため絶対インデントは変動する）。一方、終了候補
// （`maxIndent`指定時）は先頭空白をCommonMarkのfenced codeとして成立する
// 0〜3文字に制限する。これを超えるインデントを持つcode(lang無し)ノードは
// 4スペースインデントによる「本物の」インデントコードブロックであり、
// その1行目がたまたまfence marker風の文字列で始まっていても、崩壊
// シグネチャの終了候補として誤認識してはならない。戻り値の`indent`は
// raw文字列のまま（タブ・スペースを区別）保持し、paragraph吸収型
// シグネチャ（findAbsorbedFenceEnd）の開始・終了行indentation完全一致
// 判定に使う。
function fenceMarkerAtLineOf(
  sourceText: string,
  offset: number,
  {
    requireNoInfoString,
    maxIndent,
  }: { requireNoInfoString: boolean; maxIndent?: number },
): FenceMarker | undefined {
  const lineStart = sourceText.lastIndexOf('\n', offset - 1) + 1;
  const lineEndIndex = sourceText.indexOf('\n', offset);
  const lineEnd = lineEndIndex === -1 ? sourceText.length : lineEndIndex;
  const line = sourceText.slice(lineStart, lineEnd);
  const match = fenceMarkerLinePattern.exec(line);
  if (!match) return undefined;
  const indent = match[1]!;
  if (maxIndent !== undefined && indentWidth(indent) > maxIndent)
    return undefined;
  const marker = match[2]!;
  const infoString = match[3]!.trim();
  if (requireNoInfoString && infoString.length > 0) return undefined;
  return { char: marker[0] as '`' | '~', length: marker.length, indent };
}

// 終了候補ノードの最後の物理行が、それ自体を閉じる有効な終了フェンス
// 行になっているかを判定する。なっている場合、そのノードは「開始・終了
// フェンスが揃った独立した正常なコードブロック」である（崩壊した終了
// フェンス跡ではない）。単独行の崩壊フェンス跡（開始行=終了行）は除外
// する。`ownOpeningMarker`はこのノード自身の開始行（＝崩壊シグネチャの
// 終了候補としての開始位置）のマーカーを渡す。閉じ行はノード自身の開始
// フェンスと文字種・長さが対応していなければならない（別ノードの開始
// フェンスとの対応は無関係）。閉じ行の先頭空白もCommonMarkのfenced code
// として成立する0〜3文字に制限する（`isCollapsedFenceTerminator`の
// 終了候補判定と条件を揃える）。
function hasOwnClosingFenceLine(
  node: Code,
  sourceText: string,
  ownOpeningMarker: FenceMarker,
): boolean {
  const start = offsetOf(node, 'start');
  const end = offsetOf(node, 'end');
  if (start === undefined || end === undefined) return false;
  let searchEnd = end;
  if (sourceText[searchEnd - 1] === '\n') searchEnd -= 1;
  const lastLineStart = sourceText.lastIndexOf('\n', searchEnd - 1) + 1;
  const firstLineStart = sourceText.lastIndexOf('\n', start - 1) + 1;
  if (lastLineStart === firstLineStart) return false;
  const line = sourceText.slice(lastLineStart, searchEnd);
  const match = fenceMarkerLinePattern.exec(line);
  if (!match) return false;
  const indent = match[1]!;
  if (indentWidth(indent) > 3) return false;
  const infoString = match[3]!.trim();
  if (infoString.length > 0) return false;
  const marker = match[2]!;
  return (
    marker[0] === ownOpeningMarker.char &&
    marker.length >= ownOpeningMarker.length
  );
}

// 崩壊シグネチャの終了候補（isBareCodeで見つかったlang無しcodeノード）が、
// 本当に「崩壊した開始フェンスに対応する閉じフェンス跡」でありうるかを
// 検証する。次の条件をすべて満たさない限り、終了候補として扱わない：
// (1) 生Markdown文字列上で実際にfence marker行から始まり、info string
//     （言語指定）を持たない、かつ先頭空白が0〜3文字である（4スペース
//     インデントによるコードブロックを誤って終了候補と認識しない）
// (2) fence文字種が開始ノードと一致する
// (3) fence marker長が開始ノード以上（CommonMarkの閉じフェンス条件）
// (4) 終了候補ノード自身を閉じる有効な終了フェンス行を持たない（持つ
//     場合は「開始・終了フェンスが揃った独立した正常なコードブロック」
//     であり、崩壊シグネチャの終了ノードとして扱うとそのコード内容が
//     生Markdown文字列として再parseされ通常のMarkdown構文として変換
//     されてしまう。AGENTS.mdの安全不変条件「code内を変更しない」に
//     抵触するため、判別できない場合は修復せず元のASTを維持する
//     fail-closed方針を取る）
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
    maxIndent: 3,
  });
  if (openMarker === undefined || closeMarker === undefined) return false;
  if (openMarker.char !== closeMarker.char) return false;
  if (closeMarker.length < openMarker.length) return false;
  return !hasOwnClosingFenceLine(endNode, sourceText, closeMarker);
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

// CommonMarkはタブを次のタブストップ（4の倍数列）まで展開するため、
// 終了フェンス行がタブでインデントされていると実効的に4スペース以上の
// インデントになる。この行が直前の本文行の直後（間に空行なし）にある
// 場合、lazy continuationにより独立したcodeノードにならず、直前の
// paragraphへ生文字列としてただ吸収されてしまう（実Notion Markdown API
// データで確認済み。開始行だけでなく終了行もタブでインデントされる
// パターン）。さらに、終了フェンス行の直後（空行なし）に別の本文行が
// 続く場合、その本文行も同じparagraphへ吸収され、終了フェンス行が
// paragraphの「途中」に位置することもある（実データで確認済み）。
// この場合、isCollapsedFenceTerminator（孤立codeノードを終了候補とする
// 経路）が前提とする「孤立した終了候補ノード」自体がASTに存在しない。
//
// paragraph吸収型として、崩壊開始の直後に連続する各paragraphの
// `position`範囲（生Markdown文字列のoffset範囲のみ。paragraphのinline
// 構造・children配列は一切参照しない。すでにMarkdownとして解釈された
// 結果を材料にすると、strong/inlineCode等へ変換済みの内容を誤ってcode
// 本文へ混入させかねないため）を、物理行単位でraw文字列として走査し、
// 終了フェンス行として成立する行を探す（paragraphの最終行に限定しない。
// ただし探索範囲全体を通して候補が複数見つかった場合は、どれが本当の
// 終端か判別できないためfail-closedとする。候補が一意の場合のみ修復
// する）。
interface FenceLineCandidate {
  paragraphIndex: number;
  lineStart: number;
  lineEnd: number;
}

// 単一paragraphのposition範囲内を物理行単位で走査し、終了フェンス行の
// 条件（indentation raw完全一致・marker文字種一致・marker長以上・
// info stringなし・行全体がindentation+marker+後方空白のみ）を満たす
// 行をすべて収集する（一意性判定は呼び出し元の責務）。
function findFenceLineCandidatesInParagraph(
  paragraph: RootContent,
  paragraphIndex: number,
  sourceText: string,
  openMarker: FenceMarker,
): FenceLineCandidate[] {
  const start = offsetOf(paragraph, 'start');
  const end = offsetOf(paragraph, 'end');
  if (start === undefined || end === undefined) return [];
  let searchEnd = end;
  if (sourceText[searchEnd - 1] === '\n') searchEnd -= 1;
  if (sourceText[searchEnd - 1] === '\r') searchEnd -= 1;
  if (searchEnd < start) return [];
  const candidates: FenceLineCandidate[] = [];
  let lineStart = start;
  while (lineStart <= searchEnd) {
    const newlineIndex = sourceText.indexOf('\n', lineStart);
    const lineEndExclusive =
      newlineIndex === -1 || newlineIndex > searchEnd
        ? searchEnd
        : newlineIndex;
    let effectiveLineEnd = lineEndExclusive;
    if (sourceText[effectiveLineEnd - 1] === '\r') effectiveLineEnd -= 1;
    const line = sourceText.slice(lineStart, effectiveLineEnd);
    const match = fenceMarkerLinePattern.exec(line);
    if (match) {
      const indent = match[1]!;
      const marker = match[2]!;
      const infoString = match[3]!.trim();
      if (
        infoString.length === 0 &&
        indent === openMarker.indent &&
        marker[0] === openMarker.char &&
        marker.length >= openMarker.length
      ) {
        candidates.push({
          paragraphIndex,
          lineStart,
          lineEnd: effectiveLineEnd,
        });
      }
    }
    if (lineEndExclusive >= searchEnd) break;
    lineStart = lineEndExclusive + 1;
  }
  return candidates;
}

interface AbsorbedFenceTermination {
  paragraphIndex: number;
  fenceLineStart: number;
  fenceLineEnd: number;
}

// 崩壊開始の直後に連続するparagraph群全体を通して終了フェンス行候補を
// 収集する。候補が0件（見つからない）または2件以上（どれが本当の終端か
// 判別不能）の場合はfail-closedとしてundefinedを返す。候補が一意の
// 場合のみ、そのparagraph・行位置を終端として返す。
function findAbsorbedFenceTermination(
  paragraphs: readonly RootContent[],
  sourceText: string,
  openMarker: FenceMarker,
): AbsorbedFenceTermination | undefined {
  const allCandidates: FenceLineCandidate[] = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    allCandidates.push(
      ...findFenceLineCandidatesInParagraph(
        paragraph,
        paragraphIndex,
        sourceText,
        openMarker,
      ),
    );
  }
  if (allCandidates.length !== 1) return undefined;
  const candidate = allCandidates[0]!;
  return {
    paragraphIndex: candidate.paragraphIndex,
    fenceLineStart: candidate.lineStart,
    fenceLineEnd: candidate.lineEnd,
  };
}

// 開始フェンス行の直後から、指定offset（終了フェンス行の行頭）までの
// 生Markdown文字列をそのままスライスする。複数paragraph境界（空行）を
// 跨いでいても正規化・trim・再parseせず、byte-for-byteで保持する。
function extractRawContentToOffset(
  sourceText: string,
  startNode: Code,
  contentEndOffset: number,
): string | undefined {
  const contentStart = offsetOf(startNode, 'end');
  if (contentStart === undefined) return undefined;
  if (contentEndOffset < contentStart) return undefined;
  const between = sourceText.slice(contentStart, contentEndOffset);
  const withoutLeadingNewline = between.replace(/^\r?\n/u, '');
  return withoutLeadingNewline.replace(/\r?\n$/u, '');
}

// 終了フェンス行が、終端paragraphの最終行でなかった場合（フェンス行の
// 直後に空行なしで別の本文行が同一paragraphへ吸収されているケース）、
// フェンス行より後・paragraph終端までの生Markdown文字列を取り出す。
// フェンス行がparagraphの最終行だった場合は空文字列を返す（従来ケース）。
function extractTrailingFromParagraph(
  sourceText: string,
  paragraph: RootContent,
  fenceLineEnd: number,
): string | undefined {
  const paragraphEnd = offsetOf(paragraph, 'end');
  if (paragraphEnd === undefined) return undefined;
  if (fenceLineEnd > paragraphEnd) return undefined;
  // フェンス行がparagraphの最終行と一致する場合（フェンス行の終端と
  // paragraph自体の終端が同じoffset）、後続本文は存在しない（従来
  // ケース）。この場合、sourceText[fenceLineEnd]がparagraph自体を終端
  // させる改行と一致することがあり、それを「フェンス行後の改行を1つ
  // 消費する」ロジックでスキップするとcontentStartがparagraphEndを
  // 超えてしまう。これは実際にはエラーではなく「trailingが空」を
  // 意味するため、先に空文字列として確定させる。
  if (fenceLineEnd === paragraphEnd) return '';
  let contentStart = fenceLineEnd;
  if (sourceText[contentStart] === '\r') contentStart += 1;
  if (sourceText[contentStart] === '\n') contentStart += 1;
  if (contentStart > paragraphEnd) return undefined;
  return sourceText.slice(contentStart, paragraphEnd);
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

export interface ProtectedRange {
  start: number;
  end: number;
}

// protectedRangesの整合性を検証する。半開区間[start, end)で
// 0 <= start < end <= textLengthを満たさないrangeが1件でもあれば、
// pre-scan全体を信頼できないとみなし空配列を返す（fail-closed）。
// 完全一致するrangeはdeduplicateする。異なるrange同士が部分的にでも
// 重なる場合は、どちらが正しいか判別できないため空配列を返す（重なった
// rangeを広くmergeして保護する設計は、誤検出した範囲までcode扱いして
// 通常のMarkdown変換を止めてしまうため採用しない）。呼び出し元は
// pre-scan直後・offset調整後・trailing相対座標変換後のそれぞれで
// この関数を通す。
export function validateProtectedRanges(
  ranges: readonly ProtectedRange[],
  textLength: number,
): ProtectedRange[] {
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > textLength
    )
      return [];
  }
  const deduped: ProtectedRange[] = [];
  for (const range of ranges) {
    if (!deduped.some((d) => d.start === range.start && d.end === range.end))
      deduped.push(range);
  }
  const sorted = [...deduped].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return [];
  }
  return sorted;
}

// pre-parse正規化（renameKnownUnderscoreTags/insertZeroWidthSpaceForBoldFlanking）
// は、code/inlineCodeノードの範囲（collectUneditableRanges）だけを除外
// 範囲としている。しかし崩壊コードフェンスのcode本文は、初回parse時点
// ではcodeノードとして認識されず、その除外範囲に含まれない。放置すると
// pre-parse正規化がcode本文を書き換えてしまい（例:
// `<synced_block>`→`<synced-block>`、`**`直後のU+200B挿入）、「code本文は
// 元のNotion Markdownと完全一致する」という不変条件に違反する。
//
// pre-parse正規化より前の時点（sentinel退避後・rename前）のmarkdownに
// 対して、repairBrokenCodeFencesと同じ崩壊シグネチャ判定ロジックを、
// ASTを書き換えずに範囲収集のみ行う形で先に実行し、崩壊code本文の範囲を
// 確定する。これをpre-parse正規化の除外範囲に追加することで、崩壊code
// 本文がrename/U+200B挿入の対象にならないようにする。
//
// root.children（トップレベル）のみを対象にする。listItem内のネスト、
// synced_block/callout展開後のfragment内で崩壊コードフェンスが発生する
// ケースは実データで未確認のため、対象外とする（本修復側で、対応する
// 保護範囲が見つからない場合はfail-closedとして修復しない設計のため、
// 安全側に倒れる。過検出にはならない）。
//
// 経路1（孤立codeノード型）の保護範囲は「開始フェンス行の先頭」〜
// 「終了ノードのフェンス跡の開始位置」まで（trailing巻き込み部分は
// 通常Markdownとして正規化対象にすべきなので保護しない。extractRawContent
// と同じ境界）。経路2（paragraph吸収型）の保護範囲は「開始フェンス行の
// 先頭」〜「終了フェンス行の末尾」まで（trailing部分は保護しない。
// extractRawContentToOffsetと同じ境界）。
// 経路1・経路2どちらも、崩壊シグネチャが確定した際に後続本文
// （trailing）をfragmentとして再帰的にrepairBrokenCodeFencesへ渡す
// 設計になっている（隣接する崩壊リストの再帰修復等）。trailingは
// sourceTextからスライスされ、fragmentとして独立にparseされるため、
// pre-scanもこれと同じtrailing抽出・fragment化・再帰探索を行わないと、
// trailing内にネストした崩壊コードフェンスの保護範囲を検出できない
// （既存のPhase 7回帰テスト「隣接する2つの崩壊リストが...再帰的に
// 修復される」で確認済み）。ネストして見つかった範囲は、trailing文字列
// 基準のoffsetから、外側のsourceText基準のoffsetへtrailingBaseOffsetを
// 加算して変換する。
function collectNestedRangesFromTrailing(
  trailing: string,
  trailingBaseOffset: number,
): ProtectedRange[] {
  if (trailing === '') return [];
  try {
    const fragment = fragmentProcessor.parse(trailing);
    return collectCollapsedCodeRanges(fragment.children, trailing).map(
      (range) => ({
        start: range.start + trailingBaseOffset,
        end: range.end + trailingBaseOffset,
      }),
    );
  } catch {
    // remark-parseは通常どのような文字列に対しても例外を投げないため
    // 実行時には到達しない想定。本修復側と同じくfail-closed（何も
    // 追加しない）として扱う。
    return [];
  }
}

export function collectCollapsedCodeRanges(
  children: readonly RootContent[],
  sourceText: string,
): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index]!;
    if (node.type !== 'list') {
      index += 1;
      continue;
    }
    const startNode = findTrailingBrokenCodeStart(node, sourceText);
    if (startNode === undefined) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (children[cursor]?.type === 'paragraph') cursor += 1;
    const paragraphCount = cursor - (index + 1);
    if (paragraphCount === 0) {
      index += 1;
      continue;
    }
    const startOffset = offsetOf(startNode, 'start');
    const endNode = children[cursor];
    if (
      startOffset !== undefined &&
      endNode !== undefined &&
      isBareCode(endNode) &&
      isCollapsedFenceTerminator(startNode, endNode, sourceText)
    ) {
      const end = offsetOf(endNode, 'start');
      if (end !== undefined) {
        ranges.push({ start: startOffset, end });
        const trailing = extractTrailingContent(sourceText, endNode);
        const delimiterStart = offsetOf(endNode, 'start');
        if (
          trailing !== undefined &&
          trailing !== '' &&
          delimiterStart !== undefined
        ) {
          const afterDelimiterNewline = sourceText.indexOf(
            '\n',
            delimiterStart,
          );
          if (afterDelimiterNewline !== -1)
            ranges.push(
              ...collectNestedRangesFromTrailing(
                trailing,
                afterDelimiterNewline + 1,
              ),
            );
        }
      }
      index = cursor + 1;
      continue;
    }
    const openMarker =
      startOffset === undefined
        ? undefined
        : fenceMarkerAtLineOf(sourceText, startOffset, {
            requireNoInfoString: false,
          });
    if (openMarker !== undefined && startOffset !== undefined) {
      const paragraphs = children.slice(index + 1, cursor);
      const termination = findAbsorbedFenceTermination(
        paragraphs,
        sourceText,
        openMarker,
      );
      if (termination !== undefined) {
        ranges.push({ start: startOffset, end: termination.fenceLineEnd });
        const terminationParagraph = paragraphs[termination.paragraphIndex]!;
        const trailing = extractTrailingFromParagraph(
          sourceText,
          terminationParagraph,
          termination.fenceLineEnd,
        );
        if (trailing !== undefined && trailing !== '') {
          let trailingBaseOffset = termination.fenceLineEnd;
          if (sourceText[trailingBaseOffset] === '\r') trailingBaseOffset += 1;
          if (sourceText[trailingBaseOffset] === '\n') trailingBaseOffset += 1;
          ranges.push(
            ...collectNestedRangesFromTrailing(trailing, trailingBaseOffset),
          );
        }
        index = index + 1 + termination.paragraphIndex + 1;
        continue;
      }
    }
    index += 1;
  }
  return ranges;
}

interface MaybeParent {
  children?: RootContent[];
}

// transformParentは各parentの`children`に対して再帰的に処理を適用する
// （listItem内のネストしたlist等）。pre-scanもこれと同じ再帰構造で
// documentのASTツリー全体を辿り、各階層のchildren配列に対して
// collectCollapsedCodeRangesを適用する。html型ノード（synced_block等の
// 中身）は`children`を持たずtransformParent側も別のsourceTextで再帰
// fragment化するため、この再帰では潜らない（fragment内は既存の設計どおり
// pre-scan対象外＝fail-closedとして扱う。broken-code-fence.tsの
// repairBrokenCodeFences呼び出し側コメント参照）。
export function collectCollapsedCodeRangesDeep(
  parent: MaybeParent,
  sourceText: string,
): ProtectedRange[] {
  const children = parent.children;
  if (children === undefined) return [];
  const ranges = collectCollapsedCodeRanges(children, sourceText);
  for (const child of children) {
    if ('children' in child && Array.isArray(child.children))
      ranges.push(...collectCollapsedCodeRangesDeep(child, sourceText));
  }
  return ranges;
}

// 経路1・経路2それぞれで確定した候補範囲が、pre-scan（collectCollapsedCodeRanges）
// で事前に検出された保護範囲のいずれかと完全一致するかを確認する。
// pre-scanはpre-parse正規化前のmarkdownに対して行われ、本修復はpre-parse
// 正規化後のsourceTextに対して行われる（呼び出し元がoffsetを正規化後の
// 座標へ調整済みのprotectedRangesを渡す）。一致しない場合、pre-scanで
// 保護されなかった範囲がpre-parse正規化の影響を受けた可能性があるため、
// 安全側に倒して修復しない。
function isProtectedRangeConfirmed(
  start: number,
  end: number,
  protectedRanges: readonly ProtectedRange[],
): boolean {
  return protectedRanges.some(
    (range) => range.start === start && range.end === end,
  );
}

// trailingをfragmentとして再帰的にrepairBrokenCodeFencesへ渡す際、
// pre-scanが検出した保護範囲（外側sourceText基準）のうち、trailingの
// 範囲内に完全に収まるものだけを、trailing文字列基準のoffsetへ変換して
// 引き継ぐ（collectNestedRangesFromTrailingの逆方向の変換）。
function extractProtectedRangesForTrailing(
  protectedRanges: readonly ProtectedRange[],
  trailingBaseOffset: number,
  trailingLength: number,
): ProtectedRange[] {
  const trailingEnd = trailingBaseOffset + trailingLength;
  const result: ProtectedRange[] = [];
  for (const range of protectedRanges) {
    if (range.start >= trailingBaseOffset && range.end <= trailingEnd)
      result.push({
        start: range.start - trailingBaseOffset,
        end: range.end - trailingBaseOffset,
      });
  }
  return result;
}

const fragmentProcessor = unified().use(remarkParse).use(remarkGfm);

interface MaybePositioned {
  position?: unknown;
  children?: RootContent[];
}

// 差し戻すfragmentのノードはfragment化前の文字列基準のoffsetを持つ。
// 呼び出し元のtransformParentはこの後、元文書のsourceText基準でノードを
// 再帰処理するため、position情報を保持したままにすると、fragment内部
// （さらにネストしたlistItem等）で崩壊コードフェンスの検出やcallout結合
// が働いた場合に誤ったoffsetでsourceTextをスライスし、無関係な文字列を
// コード本文として書き込みかねない。以後の処理がoffsetに依存する関数は
// offset未定義を安全側フォールバックとして扱う設計のため、position自体
// を再帰的に削除しておけば以後は必ずフォールバックする。
// broken-code-fence.ts内のrepairBrokenCodeFencesだけでなく、
// enhanced-markdown.tsのjoinSplitCallouts（callout結合で後続本文を
// 再parseする際）でも同じ理由で必要なためexportする。
export function stripPositionsDeep(node: MaybePositioned): void {
  delete node.position;
  for (const child of node.children ?? []) stripPositionsDeep(child);
}

// 経路1（孤立codeノード型）を試す。成功時はtrue、それ以外の場合
// （シグネチャ不成立・fragment parse失敗を含む）はfalseを返す。
// 成功時は`result`への追加と`sourceIndexRef`の更新を呼び出し元の代わりに
// この関数が行う。確定した候補範囲（開始フェンス行〜フェンス跡の開始
// 位置）がprotectedRangesと完全一致しない場合、pre-parse正規化がcode
// 本文へ影響した可能性を排除できないため修復しない（fail-closed）。
function tryRepairIsolatedCodeSignature(
  node: RootContent,
  startNode: Code,
  children: readonly RootContent[],
  cursor: number,
  sourceText: string,
  result: RootContent[],
  protectedRanges: readonly ProtectedRange[],
): number | undefined {
  const endNode = children[cursor];
  if (
    endNode === undefined ||
    !isBareCode(endNode) ||
    !isCollapsedFenceTerminator(startNode, endNode, sourceText)
  )
    return undefined;
  const candidateStart = offsetOf(startNode, 'start');
  const candidateEnd = offsetOf(endNode, 'start');
  if (
    candidateStart === undefined ||
    candidateEnd === undefined ||
    !isProtectedRangeConfirmed(candidateStart, candidateEnd, protectedRanges)
  )
    return undefined;
  const rawContent = extractRawContent(sourceText, startNode, endNode);
  const trailing = extractTrailingContent(sourceText, endNode);
  if (rawContent === undefined || trailing === undefined) return undefined;
  let fragmentChildren: RootContent[] = [];
  if (trailing !== '') {
    try {
      const fragment = fragmentProcessor.parse(trailing);
      // trailingはsourceText（pre-parse正規化後）からスライスされたもの。
      // pre-scan（collectCollapsedCodeRanges）もtrailingを同じ手順で
      // 再帰的に辿っているため、外側のprotectedRangesのうちtrailing範囲に
      // 収まるものをtrailing相対offsetへ変換して引き継ぐ（隣接する崩壊
      // リストの再帰修復に対応するため）。
      const delimiterStart = offsetOf(endNode, 'start');
      const afterDelimiterNewline =
        delimiterStart === undefined
          ? -1
          : sourceText.indexOf('\n', delimiterStart);
      const trailingProtectedRanges =
        afterDelimiterNewline === -1
          ? []
          : validateProtectedRanges(
              extractProtectedRangesForTrailing(
                protectedRanges,
                afterDelimiterNewline + 1,
                trailing.length,
              ),
              trailing.length,
            );
      fragment.children = repairBrokenCodeFences(
        fragment.children,
        trailing,
        trailingProtectedRanges,
      );
      for (const fragmentChild of fragment.children)
        stripPositionsDeep(fragmentChild);
      fragmentChildren = fragment.children;
    } catch {
      // remark-parseは通常どのような文字列に対しても例外を投げないため
      // 実行時には到達しない想定だが、中途半端に修復するより安全側に
      // 倒し、この崩壊リストは変換せず元のASTを維持するフォールバック
      // として残す。
      return undefined;
    }
  }
  startNode.value = rawContent;
  result.push(node);
  result.push(...fragmentChildren);
  return cursor + 1;
}

// 経路2（paragraph吸収型）を試す。成功時は次のindexを返し、それ以外は
// undefinedを返す（経路1と同じ規約）。終了フェンス行がparagraphの途中に
// あり、直後に同一paragraphへ吸収された後続本文がある場合、その本文は
// codeノードのvalueへ混ぜず、fragmentとして独立にraw parseしてから
// 修復済みcodeノードの直後へ差し戻す（code本文自体は絶対に再parseしない。
// 経路1のtrailing処理と同じ設計）。fragmentのparseまたは再構成に失敗
// した場合は、部分的に適用せず修復全体を中止する。
function tryRepairAbsorbedParagraphSignature(
  node: RootContent,
  startNode: Code,
  children: readonly RootContent[],
  index: number,
  cursor: number,
  sourceText: string,
  result: RootContent[],
  protectedRanges: readonly ProtectedRange[],
): number | undefined {
  const openOffset = offsetOf(startNode, 'start');
  if (openOffset === undefined) return undefined;
  const openMarker = fenceMarkerAtLineOf(sourceText, openOffset, {
    requireNoInfoString: false,
  });
  if (openMarker === undefined) return undefined;
  const paragraphs = children.slice(index + 1, cursor);
  const termination = findAbsorbedFenceTermination(
    paragraphs,
    sourceText,
    openMarker,
  );
  if (termination === undefined) return undefined;
  if (
    !isProtectedRangeConfirmed(
      openOffset,
      termination.fenceLineEnd,
      protectedRanges,
    )
  )
    return undefined;
  const rawContent = extractRawContentToOffset(
    sourceText,
    startNode,
    termination.fenceLineStart,
  );
  if (rawContent === undefined) return undefined;
  const terminationParagraph = paragraphs[termination.paragraphIndex]!;
  const trailing = extractTrailingFromParagraph(
    sourceText,
    terminationParagraph,
    termination.fenceLineEnd,
  );
  if (trailing === undefined) return undefined;
  let fragmentChildren: RootContent[] = [];
  if (trailing !== '') {
    try {
      const fragment = fragmentProcessor.parse(trailing);
      // 経路1と同じ理由で、外側のprotectedRangesのうちtrailing範囲に
      // 収まるものをtrailing相対offsetへ変換して引き継ぐ。
      let trailingBaseOffset = termination.fenceLineEnd;
      if (sourceText[trailingBaseOffset] === '\r') trailingBaseOffset += 1;
      if (sourceText[trailingBaseOffset] === '\n') trailingBaseOffset += 1;
      const trailingProtectedRanges = validateProtectedRanges(
        extractProtectedRangesForTrailing(
          protectedRanges,
          trailingBaseOffset,
          trailing.length,
        ),
        trailing.length,
      );
      fragment.children = repairBrokenCodeFences(
        fragment.children,
        trailing,
        trailingProtectedRanges,
      );
      for (const fragmentChild of fragment.children)
        stripPositionsDeep(fragmentChild);
      fragmentChildren = fragment.children;
    } catch {
      // remark-parseは通常どのような文字列に対しても例外を投げないため
      // 実行時には到達しない想定だが、後続本文だけ再構成に失敗した状態で
      // code本文だけ修復するのは中途半端になるため、修復全体を中止する。
      return undefined;
    }
  }
  startNode.value = rawContent;
  result.push(node);
  result.push(...fragmentChildren);
  const consumedCount = termination.paragraphIndex + 1;
  for (const remaining of paragraphs.slice(consumedCount))
    result.push(remaining);
  return index + 1 + consumedCount;
}

// Notion Markdown APIは、番号付きリスト内のコードフェンスにおいて開始行
// だけをリスト継続に必要な分だけインデントし、本文行をインデントしない
// ことがある。CommonMarkのリスト継続判定は本文行のインデント不足を検出
// するとリストをそこで終了させるため、本文行は独立したparagraphへ、
// 閉じフェンス行は独立したcodeノード（lang無し）へ分裂する（崩壊シグ
// ネチャ1: 空code+lang付き → 連続paragraph → 孤立code+lang無し）。
//
// さらに、開始行だけでなく閉じフェンス行もタブでインデントされている
// 場合、CommonMarkのタブ展開（次のタブストップまで）により閉じフェンス
// 行が実効的に4スペース以上のインデントとなり、直前の本文行との間に
// 空行がないためlazy continuationで独立ノードにならず、直前のparagraph
// へ生文字列として吸収される（崩壊シグネチャ2: 空code+lang付き →
// 連続paragraph、うち最後のparagraphの末尾物理行が閉じフェンス行）。
// 生Markdown文字列から該当範囲を直接スライスし、元のインデント・空行を
// 保ったまま正しいcodeノードとして再構成する。閉じフェンス跡が後続本文
// を巻き込んでいる場合（シグネチャ1）は、その本文を取り出して再parseし、
// 修復したcodeノードの直後へ差し戻す（後続本文自体は失わない）。
// シグネチャが一部しか揃わない場合（意図的な空コードブロック等）は
// 変換せず元のASTを維持する。
//
// `protectedRanges`は、pre-parse正規化（renameKnownUnderscoreTags/
// insertZeroWidthSpaceForBoldFlanking）より前にcollectCollapsedCodeRangesで
// 事前確定した崩壊code本文の範囲（呼び出し元がpre-parse正規化後の座標へ
// 調整済み）。経路1・経路2どちらも、確定した候補範囲がこの一覧に含まれる
// 場合のみ実際に修復する。含まれない場合、pre-scanで保護されなかった
// range（トップレベル以外、またはfragment再帰内）であり、pre-parse
// 正規化の影響を受けた可能性を排除できないため修復しない。
export function repairBrokenCodeFences(
  children: RootContent[],
  sourceText: string,
  protectedRanges: readonly ProtectedRange[],
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
    if (paragraphCount === 0) {
      result.push(node);
      index += 1;
      continue;
    }
    const nextIndex =
      tryRepairIsolatedCodeSignature(
        node,
        startNode,
        children,
        cursor,
        sourceText,
        result,
        protectedRanges,
      ) ??
      tryRepairAbsorbedParagraphSignature(
        node,
        startNode,
        children,
        index,
        cursor,
        sourceText,
        result,
        protectedRanges,
      );
    if (nextIndex === undefined) {
      result.push(node);
      index += 1;
      continue;
    }
    index = nextIndex;
  }
  return result;
}
