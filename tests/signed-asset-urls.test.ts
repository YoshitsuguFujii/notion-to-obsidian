import { describe, expect, it } from 'vitest';
import { replaceRetainedSignedUrls } from '../src/transform/signed-asset-urls.js';

const signed =
  'https://file.notion.so/document.png?X-Amz-Signature=test-signature#temporary';
const stable = 'https://file.notion.so/document.png';

const noUnsafeUrls = {
  boundaryUndeterminedCount: 0,
  unparseableSignedUrlCount: 0,
};

describe('replaceRetainedSignedUrls', () => {
  it.each([
    'https://notion.so/file.png?signature=value',
    'https://file.notion.so/file.png?expirationTimestamp=123',
    'https://notion-static.com/file.png?Expires=123',
    'https://cdn.notion-static.com/file.png?AWSAccessKeyId=value',
    'https://prod-files-secure.s3.us-west-2.amazonaws.com/file.png?X-Amz-Credential=value',
    'https://prod-files-secure.s3.amazonaws.com/file.png?X-Amz-Algorithm=value',
    'https://s3.us-west-2.amazonaws.com/secure.notion-static.com/file.png?X-Amz-Date=value',
    'https://s3.amazonaws.com/secure.notion-static.com/file.png?X-Amz-Expires=',
  ])('構文境界で終わるNotion由来の一時URLを安定参照へ変換する: %s', (url) => {
    const result = replaceRetainedSignedUrls(`![asset](${url})`);

    expect(result).toEqual({
      markdown: `![asset](${new URL(url).origin + new URL(url).pathname})`,
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it.each([
    'https://file.notion.so/file.png',
    'https://example.com/file.png?X-Amz-Signature=value',
    'https://notion.so.evil.example/file.png?Signature=value',
    'https://notion.so@evil.example/file.png?Signature=value',
    'https://s3.us-west-2.amazonaws.com/user-content/secure.notion-static.com/file.png?Signature=value',
    'https://s3-us-west-2.amazonaws.com/secure.notion-static.com/file.png?Signature=value',
    'https://file.notion.so:8443/file.png?Signature=value',
    'https://user:password@file.notion.so/file.png?Signature=value',
    '../_assets/file.png?Signature=value',
  ])('対象外のURLを変更も安全停止対象にも含めない: %s', (url) => {
    expect(replaceRetainedSignedUrls(url)).toEqual({
      markdown: url,
      replacedCount: 0,
      ...noUnsafeUrls,
    });
  });

  it('scheme・host・query keyの大文字小文字を区別せず変換する', () => {
    expect(
      replaceRetainedSignedUrls(
        'HTTPS://FILE.NOTION.SO/file.png?x-amz-signature=value ',
      ),
    ).toEqual({
      markdown: 'https://file.notion.so/file.png ',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('標準portを持つURLを通常のhttps URLとして扱う', () => {
    expect(
      replaceRetainedSignedUrls(
        'https://file.notion.so:443/file.png?Signature=value ',
      ),
    ).toEqual({
      markdown: 'https://file.notion.so/file.png ',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('percent encodeされた署名keyと重複keyを検出する', () => {
    const input =
      'https://file.notion.so/file.png?ignored=1&%58-Amz-Signature=&X-Amz-Signature=second ';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: 'https://file.notion.so/file.png ',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it.each([
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Amz-Algorithm',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-SignedHeaders',
    'X-Amz-Security-Token',
    'AWSAccessKeyId',
    'Signature',
    'Expires',
    'expirationTimestamp',
  ])('署名parameter %s は空値でも検出する', (parameter) => {
    expect(
      replaceRetainedSignedUrls(
        `![asset](https://file.notion.so/file.png?${parameter}=)`,
      ),
    ).toEqual({
      markdown: '![asset](https://file.notion.so/file.png)',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('HTML entityで区切られた署名keyを検出して周辺HTMLを維持する', () => {
    const input =
      '<img src="https://file.notion.so/file.png?name=a&amp;X-Amz-Signature=value">';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '<img src="https://file.notion.so/file.png">',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('MarkdownとHTMLのdelimiterを維持する', () => {
    const input = [
      `![image](${signed})`,
      `Sentence ${signed}. `,
      `<${signed}>`,
      `<img src='${signed}'>`,
    ].join('\n');
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: [
        `![image](${stable})`,
        `Sentence ${stable}. `,
        `<${stable}>`,
        `<img src='${stable}'>`,
      ].join('\n'),
      replacedCount: 4,
      ...noUnsafeUrls,
    });
  });

  it.each(['.', ',', ';', ':', '!', '?'])(
    '文末記号 %s を証明済み境界の前でURLの外側に維持する',
    (punctuation) => {
      expect(replaceRetainedSignedUrls(`${signed}${punctuation} `)).toEqual({
        markdown: `${stable}${punctuation} `,
        replacedCount: 1,
        ...noUnsafeUrls,
      });
    },
  );

  it('URL path内の括弧を保持してMarkdownの閉じ括弧だけをURL外に残す', () => {
    const input =
      '![image](https://file.notion.so/folder/(draft)/file.png?Signature=value)';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '![image](https://file.notion.so/folder/(draft)/file.png)',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('日本語とMarkdownの境界に続く本文を保持する', () => {
    const cases = [
      [`${signed}、後ろ`, `${stable}、後ろ`],
      [`${signed}。後ろ`, `${stable}。後ろ`],
      [`${signed}です`, `${stable}です`],
      [`[${signed}](https://example.com)`, `[${stable}](https://example.com)`],
      [`{${signed}}`, `{${stable}}`],
      [`${signed}（後ろ）`, `${stable}（後ろ）`],
    ];
    for (const [input, expected] of cases) {
      expect(replaceRetainedSignedUrls(input!)).toEqual({
        markdown: expected,
        replacedCount: 1,
        ...noUnsafeUrls,
      });
    }
  });

  it('空白で区切られた複数URLを個別に変換する', () => {
    const another = 'https://cdn.notion-static.com/another.pdf?Expires=123';
    const input = `${signed} ${another} `;
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: `${stable} https://cdn.notion-static.com/another.pdf `,
      replacedCount: 2,
      ...noUnsafeUrls,
    });
  });

  it.each([
    `${signed},next `,
    `${signed}&next `,
    `${signed}&redirect=https://example.com `,
    `${signed};https://example.com `,
    signed,
  ])('本文との境界を証明できないNotion URLは変更しない: %s', (input) => {
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 1,
      unparseableSignedUrlCount: 0,
    });
  });

  it.each([
    'https://file.notion.so/file.png?Signature=% ',
    'https://file.notion.so/file.png?Signature=%GG ',
  ])(
    '既知Notion hostで解釈できない署名URLは安全停止対象にする: %s',
    (input) => {
      expect(replaceRetainedSignedUrls(input)).toEqual({
        markdown: input,
        replacedCount: 0,
        boundaryUndeterminedCount: 0,
        unparseableSignedUrlCount: 1,
      });
    },
  );

  it.each([
    'https://[invalid]/file.png?Signature=value ',
    'https://example.com/画像.png?Signature=value ',
    'https://file.notion.so@evil.example/file.png?Signature=value ',
    'https://notion.so.evil.example/file.png?Signature=value ',
    'https://file.notion.so:8443/file.png?Signature=value ',
  ])('既知Notion hostと識別できないURLは安全停止対象にしない: %s', (input) => {
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      ...noUnsafeUrls,
    });
  });

  it('署名parameter名の部分一致では安全停止対象にしない', () => {
    const input =
      'https://file.notion.so/file.png?fooX-Amz-Signaturebar=value ';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      ...noUnsafeUrls,
    });
  });

  it('同じ変換を繰り返しても本文を変更しない', () => {
    const once = replaceRetainedSignedUrls(`![asset](${signed})`);
    const twice = replaceRetainedSignedUrls(once.markdown);

    expect(twice).toEqual({
      markdown: once.markdown,
      replacedCount: 0,
      ...noUnsafeUrls,
    });
  });
});
