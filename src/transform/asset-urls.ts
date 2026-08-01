import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

interface Span {
  start: number;
  end: number;
}

interface DestinationToken {
  start: { offset: number };
  end: { offset: number };
}

// link / image ノードの destination token の位置。parse 中に enter.resourceDestination を
// 通じて収集する。単一スレッド・同期呼び出しの前提で、parse 呼び出しのたびにリセットする。
// signed-asset-urls.ts と同じ手法（micromarkのtoken位置）を、asset URL 置換専用に再実装した
// ものであり、あちらの安全性クリティカルな実装（autolink/html-attribute/html-rescue対応を
// 含む）へは依存しない。影響範囲を最小化するための意図的な重複である。
let destinationTokenSpans: Span[] = [];

function collectDestinationTokens(this: {
  data: (key: string) => unknown;
}): void {
  const data = this.data('fromMarkdownExtensions') as unknown[] | undefined;
  const extensions = data ?? [];
  extensions.push({
    enter: {
      resourceDestination(token: DestinationToken): void {
        destinationTokenSpans.push({
          start: token.start.offset,
          end: token.end.offset,
        });
      },
    },
  });
  (this as unknown as { data: (key: string, value: unknown) => void }).data(
    'fromMarkdownExtensions',
    extensions,
  );
}

// parse だけを行い stringify はしない。AGENTS.md が禁じる round-trip（複数回の
// parse→stringify）による callout 記法（`> [!type]`）等の破壊を避けるため。
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(collectDestinationTokens);

// link / image ノードの直接の子孫にある link / image ノードの範囲。CommonMark はリンクの
// 入れ子を許さないが、リンクテキストに画像は置ける（`[![alt](inner)](outer)`）。内側の
// destination token を外側の destination と取り違えないために除外範囲として使う。
function descendantLinkOrImageRanges(node: Nodes): Span[] {
  const ranges: Span[] = [];
  const children = 'children' in node ? node.children : undefined;
  for (const child of children ?? []) {
    const childStart = child.position?.start.offset;
    const childEnd = child.position?.end.offset;
    if (
      (child.type === 'link' || child.type === 'image') &&
      childStart !== undefined &&
      childEnd !== undefined
    )
      ranges.push({ start: childStart, end: childEnd });
    ranges.push(...descendantLinkOrImageRanges(child));
  }
  return ranges;
}

function ownDestinationToken(
  start: number,
  end: number,
  exclude: Span[],
): Span | undefined {
  return destinationTokenSpans.find(
    (span) =>
      span.start >= start &&
      span.end <= end &&
      !exclude.some(
        (range) => span.start >= range.start && span.end <= range.end,
      ),
  );
}

interface DestinationSpan extends Span {
  url: string;
  // true の場合、span は囲む `<` `>` を含む（destination が山括弧記法で書かれている）。
  // 置換値は `<...>` を保ったまま内側だけを差し替える必要があり、formatDestination の
  // 空白判定による再度の山括弧付与（二重括り）を避けるため区別する。
  bracketed: boolean;
}

function linkNodeDestinationSpan(
  markdown: string,
  node: Nodes,
): DestinationSpan | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const url = (node as { url?: unknown }).url;
  if (start === undefined || end === undefined || typeof url !== 'string')
    return undefined;
  // autolink `<https://…>`。ノード全体が destination そのものであり、CommonMark の
  // autolink は内容が URI であることを要求するため、scheme を持たないローカルパスへの
  // 置換では構文として成立しない。置換対象にできないため未解決のまま元の URL を残す。
  if (markdown[start] === '<') return undefined;
  const token = ownDestinationToken(
    start,
    end,
    descendantLinkOrImageRanges(node),
  );
  if (!token) return undefined;
  // `[text](<url>)` の山括弧記法。span は囲む `<` `>` ごと含める（bracketed: true）。
  if (markdown[token.start] === '<' && markdown[token.end - 1] === '>')
    return { start: token.start, end: token.end, url, bracketed: true };
  return { ...token, url, bracketed: false };
}

function collectDestinationSpans(
  markdown: string,
  node: Nodes,
  spans: DestinationSpan[],
): void {
  if (node.type === 'link' || node.type === 'image') {
    const span = linkNodeDestinationSpan(markdown, node);
    if (span) spans.push(span);
  }
  const children = 'children' in node ? node.children : undefined;
  for (const child of children ?? [])
    collectDestinationSpans(markdown, child, spans);
}

// CommonMark の link destination（山括弧を伴わない生の形）として安全な形へ整形する。
// `mdast-util-to-markdown` の link ハンドラと同じ判定・エスケープ規則を踏襲する:
// 制御文字・空白・DEL を含む場合は `<...>` で括り内側の `<` `>` をエスケープし、
// それ以外は `(` `)` だけをエスケープする（置換値はローカルパスであり、この2点を
// 満たさないと出力後の再パースでリンクとして成立しなくなる）。
function escapeBracketedDestination(destination: string): string {
  return destination.replaceAll(/[<>]/gu, (character) => `\\${character}`);
}

function formatDestination(destination: string): string {
  if (/[\0- ]/u.test(destination))
    return `<${escapeBracketedDestination(destination)}>`;
  return destination.replaceAll(/[()]/gu, (character) => `\\${character}`);
}

export function rewriteAssetUrls(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): Promise<string> {
  if (replacements.size === 0) return Promise.resolve(markdown);

  destinationTokenSpans = [];
  let tree: Nodes;
  try {
    tree = markdownParser.parse(markdown);
  } catch {
    return Promise.resolve(markdown);
  }

  const spans: DestinationSpan[] = [];
  collectDestinationSpans(markdown, tree, spans);
  const matched = spans
    .filter((span) => replacements.has(span.url))
    .sort((left, right) => left.start - right.start);
  if (matched.length === 0) return Promise.resolve(markdown);

  const output: string[] = [];
  let sourceStart = 0;
  for (const span of matched) {
    // 重なりを許すと sourceStart が後退して出力に本文が二重に現れる（入れ子リンク画像等）。
    if (span.start < sourceStart) continue;
    const rawValue = replacements.get(span.url)!.replaceAll('\\', '/');
    const replacementValue = span.bracketed
      ? `<${escapeBracketedDestination(rawValue)}>`
      : formatDestination(rawValue);
    output.push(markdown.slice(sourceStart, span.start), replacementValue);
    sourceStart = span.end;
  }
  output.push(markdown.slice(sourceStart));
  return Promise.resolve(output.join(''));
}
