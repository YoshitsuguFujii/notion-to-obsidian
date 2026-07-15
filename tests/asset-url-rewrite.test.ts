import { describe, expect, it } from 'vitest';
import { rewriteAssetUrls } from '../src/transform/asset-urls.js';

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
});
