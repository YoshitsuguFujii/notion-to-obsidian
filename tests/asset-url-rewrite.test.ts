import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { rewriteAssetUrls } from '../src/transform/asset-urls.js';
import { transformEnhancedMarkdown } from '../src/transform/enhanced-markdown.js';

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

  it('autolink（`<url>`）はローカルパスへ置換せず元のURLのまま残す', async () => {
    const url = 'https://files.example/photo.png?signature=temporary';
    const markdown = `<${url}>`;

    const result = await rewriteAssetUrls(
      markdown,
      new Map([[url, '_assets/page/photo.png']]),
    );

    expect(result).toBe(markdown);
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
