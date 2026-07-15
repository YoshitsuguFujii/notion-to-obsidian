import { describe, expect, it } from 'vitest';
import type { BlockNode } from '../src/notion/blocks.js';
import {
  buildAssetPath,
  createStableAssetKey,
  extractBlockAssets,
  matchMarkdownAssets,
  type MarkdownAsset,
} from '../src/assets/mapping.js';

const markdownAsset = (
  url: string,
  overrides: Partial<MarkdownAsset> = {},
): MarkdownAsset => ({
  kind: 'image',
  url,
  filename: 'photo.png',
  caption: 'Photo',
  occurrence: 0,
  ...overrides,
});

describe('asset identity and path', () => {
  it('page IDとblock IDからstable keyを生成する', () => {
    expect(createStableAssetKey('page-id', 'block-id')).toBe(
      'page-id:block-id',
    );
  });

  it('page移動に依存しないsanitize済み保存パスを生成する', () => {
    expect(
      buildAssetPath('page-id', 'block-id', 'photo?.png', 'image/png'),
    ).toBe('_assets/page-id/block-id--photo-.png');
    expect(
      buildAssetPath('page-id', 'block-id', 'Untitled', 'image/jpeg'),
    ).toBe('_assets/page-id/block-id--Untitled.jpg');
  });
});

describe('extractBlockAssets', () => {
  it('再帰Block treeから対応種別と出現順を抽出する', () => {
    const nodes: BlockNode[] = [
      {
        block: {
          id: 'image-id',
          type: 'image',
          image: {
            type: 'file',
            file: { url: 'https://files.example/path/photo.png?signature=one' },
            caption: [{ plain_text: 'Photo' }],
          },
        },
        children: [
          {
            block: {
              id: 'file-id',
              type: 'file',
              file: {
                type: 'external',
                external: { url: 'https://files.example/docs/report.pdf' },
                name: 'report.pdf',
              },
            },
            children: [],
          },
        ],
      },
    ];

    expect(extractBlockAssets(nodes)).toEqual([
      {
        blockId: 'image-id',
        kind: 'image',
        url: 'https://files.example/path/photo.png?signature=one',
        filename: 'photo.png',
        caption: 'Photo',
        occurrence: 0,
      },
      {
        blockId: 'file-id',
        kind: 'file',
        url: 'https://files.example/docs/report.pdf',
        filename: 'report.pdf',
        caption: '',
        occurrence: 0,
      },
    ]);
  });
});

describe('matchMarkdownAssets', () => {
  const blocks = [
    {
      blockId: 'block-a',
      kind: 'image' as const,
      url: 'https://files.example/path/photo.png?signature=old',
      filename: 'photo.png',
      caption: 'Photo',
      occurrence: 0,
    },
  ];

  it('署名queryを除いたURL path一致を最優先する', () => {
    expect(
      matchMarkdownAssets(
        [markdownAsset('https://files.example/path/photo.png?signature=new')],
        blocks,
      ),
    ).toEqual([
      expect.objectContaining({
        status: 'matched',
        blockId: 'block-a',
        strategy: 'url_path',
      }),
    ]);
  });

  it('URL pathが違ってもfilenameが一意なら対応する', () => {
    expect(
      matchMarkdownAssets(
        [markdownAsset('https://cdn.example/temporary/other-path')],
        blocks,
      )[0],
    ).toMatchObject({
      status: 'matched',
      blockId: 'block-a',
      strategy: 'filename',
    });
  });

  it('一意に対応しない場合はambiguousを返してblockを推測しない', () => {
    const duplicateBlocks = [...blocks, { ...blocks[0]!, blockId: 'block-b' }];

    expect(
      matchMarkdownAssets(
        [markdownAsset('https://files.example/path/photo.png?signature=new')],
        duplicateBlocks,
      )[0],
    ).toEqual({
      markdownIndex: 0,
      status: 'ambiguous',
      reason: 'url_path matched multiple blocks',
    });
  });

  it('URLとfilenameが無くても種別・出現順・captionが一意なら対応する', () => {
    expect(
      matchMarkdownAssets(
        [markdownAsset('not-a-url', { filename: undefined })],
        [{ ...blocks[0]!, url: undefined, filename: undefined }],
      )[0],
    ).toMatchObject({
      status: 'matched',
      blockId: 'block-a',
      strategy: 'position_caption',
    });
  });
});
