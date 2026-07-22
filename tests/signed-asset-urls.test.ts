import { describe, expect, it } from 'vitest';
import { replaceRetainedSignedUrls } from '../src/transform/signed-asset-urls.js';

const signed =
  'https://file.notion.so/document.png?X-Amz-Signature=test-signature#temporary';
const stable = 'https://file.notion.so/document.png';

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
  ])('Notion由来と判定できる一時URLを安定参照へ変換する: %s', (url) => {
    const result = replaceRetainedSignedUrls(url);

    expect(result).toEqual({
      markdown: new URL(url).origin + new URL(url).pathname,
      replacedCount: 1,
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
  ])('対象外のURLを変更しない: %s', (url) => {
    expect(replaceRetainedSignedUrls(url)).toEqual({
      markdown: url,
      replacedCount: 0,
    });
  });

  it('scheme・host・query keyの大文字小文字を区別しない', () => {
    expect(
      replaceRetainedSignedUrls(
        'HTTPS://FILE.NOTION.SO/file.png?x-amz-signature=value',
      ),
    ).toEqual({
      markdown: 'https://file.notion.so/file.png',
      replacedCount: 1,
    });
  });

  it('標準portを持つURLを通常のhttp URLとして扱う', () => {
    expect(
      replaceRetainedSignedUrls(
        'https://file.notion.so:443/file.png?Signature=value',
      ),
    ).toEqual({
      markdown: 'https://file.notion.so/file.png',
      replacedCount: 1,
    });
  });

  it('percent encodeされた署名keyと重複keyを検出する', () => {
    const input =
      'https://file.notion.so/file.png?ignored=1&%58-Amz-Signature=&X-Amz-Signature=second';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: 'https://file.notion.so/file.png',
      replacedCount: 1,
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
        `https://file.notion.so/file.png?${parameter}=`,
      ),
    ).toEqual({
      markdown: 'https://file.notion.so/file.png',
      replacedCount: 1,
    });
  });

  it('HTML entityで区切られた署名keyを検出して周辺HTMLを維持する', () => {
    const input =
      '<img src="https://file.notion.so/file.png?name=a&amp;X-Amz-Signature=value">';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '<img src="https://file.notion.so/file.png">',
      replacedCount: 1,
    });
  });

  it('MarkdownとHTMLのdelimiterを維持する', () => {
    const input = [
      `![image](${signed})`,
      `Sentence ${signed}.`,
      `<${signed}>`,
      `<img src='${signed}'>`,
    ].join('\n');
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: [
        `![image](${stable})`,
        `Sentence ${stable}.`,
        `<${stable}>`,
        `<img src='${stable}'>`,
      ].join('\n'),
      replacedCount: 4,
    });
  });

  it.each(['.', ',', ';', ':', '!', '?'])(
    '文末記号 %s をURLの外側に維持する',
    (punctuation) => {
      expect(replaceRetainedSignedUrls(`${signed}${punctuation}`)).toEqual({
        markdown: `${stable}${punctuation}`,
        replacedCount: 1,
      });
    },
  );

  it('hostnameの末尾dotをラベル境界を保ったまま許可する', () => {
    expect(
      replaceRetainedSignedUrls(
        'https://file.notion.so./file.png?Signature=value',
      ),
    ).toEqual({
      markdown: 'https://file.notion.so./file.png',
      replacedCount: 1,
    });
  });

  it('URL path内の括弧を保持してMarkdownの閉じ括弧だけをURL外に残す', () => {
    const input =
      '![image](https://file.notion.so/folder/(draft)/file.png?Signature=value)';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '![image](https://file.notion.so/folder/(draft)/file.png)',
      replacedCount: 1,
    });
  });

  it('コードフェンス・inline code・HTML block内も安定参照へ変換する', () => {
    const input = [
      '```md',
      signed,
      '```',
      '',
      `\`${signed}\``,
      '',
      '<table>',
      `![image](${signed})`,
    ].join('\n');
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: [
        '```md',
        stable,
        '```',
        '',
        `\`${stable}\``,
        '',
        '<table>',
        `![image](${stable})`,
      ].join('\n'),
      replacedCount: 3,
    });
  });

  it('同一URLの複数出現と異なるURLを出現単位で数える', () => {
    const another = 'https://cdn.notion-static.com/another.pdf?Expires=123';
    const input = `${signed}\n${signed}\n${another}\nhttps://example.com/?signature=keep`;
    const result = replaceRetainedSignedUrls(input);

    expect(result.markdown).toBe(
      `${stable}\n${stable}\nhttps://cdn.notion-static.com/another.pdf\nhttps://example.com/?signature=keep`,
    );
    expect(result.replacedCount).toBe(3);
  });

  it.each([
    'https://file.notion.so/file.png?Signature=%',
    'https://file.notion.so/file.png?Signature=%GG',
    'https://[invalid]/file.png?Signature=value',
  ])('解釈できないURLを変更せず処理を継続する: %s', (url) => {
    expect(replaceRetainedSignedUrls(`before ${url} after`)).toEqual({
      markdown: `before ${url} after`,
      replacedCount: 0,
    });
  });

  it('同じ変換を繰り返しても本文を変更しない', () => {
    const once = replaceRetainedSignedUrls(signed);
    const twice = replaceRetainedSignedUrls(once.markdown);

    expect(twice).toEqual({ markdown: once.markdown, replacedCount: 0 });
  });
});
