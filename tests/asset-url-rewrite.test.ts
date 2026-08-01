import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { rewriteAssetUrls } from '../src/transform/asset-urls.js';
import { transformEnhancedMarkdown } from '../src/transform/enhanced-markdown.js';
import { replaceRetainedSignedUrls } from '../src/transform/signed-asset-urls.js';

function firstDestinationUrl(markdown: string): string | undefined {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  let found: string | undefined;
  const visit = (node: Nodes): void => {
    if (found !== undefined) return;
    if (node.type === 'image' || node.type === 'link') {
      found = node.url;
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  return found;
}

// 最初の link ノードのラベルが単一の text ノードとして残っているか（emphasis/
// strikethrough等のインライン構文へ分解されていないか）を確認する。分解されていれば
// undefined を返す。
function firstLinkLabelPlainText(markdown: string): string | undefined {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  let visited = false;
  let found: string | undefined;
  const visit = (node: Nodes): void => {
    if (visited) return;
    if (node.type === 'link') {
      visited = true;
      const [only] = node.children;
      found =
        node.children.length === 1 && only?.type === 'text'
          ? only.value
          : undefined;
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  return found;
}

describe('rewriteAssetUrls', () => {
  it('対応済みimage/file URLだけをローカルPOSIX参照へ変換する', async () => {
    const markdown = [
      '![Photo](https://files.example/photo.png?signature=temporary)',
      '',
      '[Report](https://files.example/report.pdf?signature=temporary)',
      '',
      '![External](https://external.example/image.png)',
    ].join('\n');
    const replacements = new Map([
      [
        'https://files.example/photo.png?signature=temporary',
        '_assets/page/image--photo.png',
      ],
      [
        'https://files.example/report.pdf?signature=temporary',
        '_assets/page/file--report.pdf',
      ],
    ]);

    const result = await rewriteAssetUrls(markdown, replacements);

    expect(result).toContain('![Photo](_assets/page/image--photo.png)');
    expect(result).toContain('[Report](_assets/page/file--report.pdf)');
    expect(result).toContain('![External](https://external.example/image.png)');
    expect(result).not.toContain('signature=temporary');
  });

  it('code blockとinline code内のURLを変更しない', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `\`${url}\`\n\n\`\`\`text\n${url}\n\`\`\``;

    await expect(
      rewriteAssetUrls(markdown, new Map([[url, '_assets/photo.png']])),
    ).resolves.toContain(`\`${url}\``);
    await expect(
      rewriteAssetUrls(markdown, new Map([[url, '_assets/photo.png']])),
    ).resolves.toContain(`\`\`\`text\n${url}\n\`\`\``);
  });

  it('calloutのMarkdown記法を空の置換マップでもエスケープしない', async () => {
    const enhanced = await transformEnhancedMarkdown(
      '<callout type="warning">\nBe careful with this.\n</callout>\n',
    );

    const result = await rewriteAssetUrls(enhanced, new Map());

    expect(result).toBe(enhanced);
    expect(result).not.toContain('\\[!warning]');
  });

  it('calloutのMarkdown記法を非空の置換マップでもエスケープしない', async () => {
    const enhanced = await transformEnhancedMarkdown(
      [
        '![Photo](https://files.example/photo.png?signature=temporary)',
        '',
        '<callout type="warning">',
        'Be careful with this.',
        '</callout>',
        '',
      ].join('\n'),
    );

    const result = await rewriteAssetUrls(
      enhanced,
      new Map([
        [
          'https://files.example/photo.png?signature=temporary',
          '_assets/page/image--photo.png',
        ],
      ]),
    );

    expect(result).toContain('![Photo](_assets/page/image--photo.png)');
    expect(result).toContain('> [!warning]');
    expect(result).not.toContain('\\[!warning]');
  });

  it('実データ形状のfixtureでtransformEnhancedMarkdown→rewriteAssetUrlsの順を通してもcalloutが壊れない', async () => {
    const input = await readFile(
      new URL('./fixtures/enhanced-markdown-input.md', import.meta.url),
      'utf8',
    );
    const enhanced = await transformEnhancedMarkdown(input);

    const result = await rewriteAssetUrls(enhanced, new Map());

    expect(result).toBe(enhanced);
    expect(result).toContain('> [!warning]');
    expect(result).not.toContain('\\[!warning]');
  });

  it('空白を含むローカルパスへ置換してもリンクとして成立する形で埋め込む', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `![Photo](${url})`;
    const localPath = '_assets/page/block--Screen Shot 2024-01-01.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe(`![Photo](<${localPath}>)`);
  });

  it('括弧を含むローカルパスへ置換してもリンクとして成立する形でエスケープする', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `![Photo](${url})`;
    const localPath = '_assets/page/block--photo(1).png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe('![Photo](_assets/page/block--photo\\(1\\).png)');
  });

  it('山括弧付きdestination（`](<url>)`）へ空白を含むローカルパスを置換しても二重に括らない', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `[Report](<${url}>)`;
    const localPath = '_assets/page/block--Screen Shot 2024-01-01.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe(`[Report](<${localPath}>)`);
  });

  it('autolink（`<url>`）を通常リンク形式へ変換し、ローカルパスを参照する（署名URL原文は本文に残さない）', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;
    const localPath = '_assets/page/photo.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe(`[\\_assets/page/photo.png](${localPath})`);
    expect(result).not.toContain(url);
  });

  it('autolinkの置換結果がreplaceRetainedSignedUrlsのbare-URL安全停止を誘発しない', async () => {
    const signedUrl =
      'https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/photo.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';
    const markdown = `<${signedUrl}>\n`;

    const rewritten = await rewriteAssetUrls(
      markdown,
      new Map([[signedUrl, '_assets/page/photo.png']]),
    );
    const final = replaceRetainedSignedUrls(rewritten);

    expect(final.unsafe).toEqual([]);
  });

  it('autolinkの置換で`[``]`を含むローカルパスをリンクラベルとしてエスケープする', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;
    const localPath = '_assets/page/photo[draft].png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe(
      '[\\_assets/page/photo\\[draft\\].png](_assets/page/photo[draft].png)',
    );
  });

  it('autolinkの置換でバッククォートを含むローカルパスはリンクラベルとして正しく成立する', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;
    const localPath = '_assets/page/a`b.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe('[\\_assets/page/a\\`b.png](_assets/page/a`b.png)');
    expect(firstDestinationUrl(result)).toBe(localPath);
  });

  it('autolinkの置換でアンダースコアを含むローカルパスが強調記法として解釈されない', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;
    const localPath = '_assets/page/foo_bar_.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(firstLinkLabelPlainText(result)).toBe(localPath);
    expect(firstDestinationUrl(result)).toBe(localPath);
  });

  it('autolinkの置換でチルダを含むローカルパスが取り消し線として解釈されない', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;
    const localPath = '_assets/page/foo~~draft~~.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(firstLinkLabelPlainText(result)).toBe(localPath);
    expect(firstDestinationUrl(result)).toBe(localPath);
  });

  it('autolinkの置換で空白を含むローカルパスはdestinationが山括弧形になる', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;
    const localPath = '_assets/page/photo copy.png';

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(result).toBe(`[\\_assets/page/photo copy.png](<${localPath}>)`);
  });

  it.each([
    ['_assets/page/a&copy;.png'],
    ['_assets/page/a&amp;.png'],
    ['_assets/page/a&#35;.png'],
    ['_assets/page/a&#x23;.png'],
  ])(
    '実体参照に見える文字列%sを含むローカルパスは再parseしても元のパスと一致する',
    async (localPath) => {
      const url = 'https://files.example/photo.png?signature=temporary';
      const markdown = `![x](${url})`;

      const result = await rewriteAssetUrls(
        markdown,
        new Map([[url, localPath]]),
      );

      expect(firstDestinationUrl(result)).toBe(localPath);
    },
  );

  it('山括弧付きdestinationでも実体参照に見える文字列を含むローカルパスは再parseしても元のパスと一致する', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const localPath = '_assets/page/a&copy; b.png';
    const markdown = `[Report](<${url}>)`;

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, localPath]]),
    );

    expect(firstDestinationUrl(result)).toBe(localPath);
  });

  it('入れ子のリンク内画像で内側・外側の両方のURLを置換する', async () => {
    const innerUrl = 'https://files.example/inner.png?signature=temporary';
    const outerUrl = 'https://files.example/outer.pdf?signature=temporary';
    const markdown = `[![Inner](${innerUrl})](${outerUrl})`;
    const replacements = new Map([
      [innerUrl, '_assets/page/inner.png'],
      [outerUrl, '_assets/page/outer.pdf'],
    ]);

    const result = await rewriteAssetUrls(markdown, replacements);

    expect(result).toBe(
      '[![Inner](_assets/page/inner.png)](_assets/page/outer.pdf)',
    );
  });
});
