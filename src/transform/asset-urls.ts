import type { Nodes, Root } from 'mdast';
import type { Parent } from 'unist';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

function transformParent(
  parent: Parent,
  replacements: ReadonlyMap<string, string>,
): void {
  for (const child of parent.children as Nodes[]) {
    if (child.type === 'link' || child.type === 'image') {
      const replacement = replacements.get(child.url);
      if (replacement) child.url = replacement.replaceAll('\\', '/');
    }
    if ('children' in child && Array.isArray(child.children)) {
      transformParent(child, replacements);
    }
  }
}

function assetUrls(
  replacements: ReadonlyMap<string, string>,
): Plugin<[], Root> {
  return () => (tree) => transformParent(tree, replacements);
}

export async function rewriteAssetUrls(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(assetUrls(replacements))
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      listItemIndent: 'one',
      rule: '-',
    });
  return String(await processor.process(markdown));
}
