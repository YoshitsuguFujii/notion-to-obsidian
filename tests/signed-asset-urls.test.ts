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
        '![asset](HTTPS://FILE.NOTION.SO/file.png?x-amz-signature=value)',
      ),
    ).toEqual({
      markdown: '![asset](https://file.notion.so/file.png)',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('標準portを持つURLを通常のhttps URLとして扱う', () => {
    expect(
      replaceRetainedSignedUrls(
        '![asset](https://file.notion.so:443/file.png?Signature=value)',
      ),
    ).toEqual({
      markdown: '![asset](https://file.notion.so/file.png)',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('percent encodeされた署名keyと重複keyを検出する', () => {
    const input =
      '![asset](https://file.notion.so/file.png?ignored=1&%58-Amz-Signature=&X-Amz-Signature=second)';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '![asset](https://file.notion.so/file.png)',
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

  it('構文で範囲が確定するMarkdownとHTMLのdelimiterを維持する', () => {
    const input = [
      `![image](${signed})`,
      `[link](<${signed}>)`,
      `<${signed}>`,
      `<img src='${signed}'>`,
      `<img src="${signed}">`,
    ].join('\n');
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: [
        `![image](${stable})`,
        `[link](<${stable}>)`,
        `<${stable}>`,
        `<img src='${stable}'>`,
        `<img src="${stable}">`,
      ].join('\n'),
      replacedCount: 5,
      ...noUnsafeUrls,
    });
  });

  it('destinationのtitleを残してURLだけを変換する', () => {
    expect(
      replaceRetainedSignedUrls(`![image](${signed} "caption")\n`),
    ).toEqual({
      markdown: `![image](${stable} "caption")\n`,
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('HTMLブロックの内側でも開き括弧と閉じ括弧が揃う画像記法は範囲を確定する', () => {
    const input = `<table>\n![image](${signed})\n`;
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: `<table>\n![image](${stable})\n`,
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it.each([
    `<table>\nfoo](${signed}(note))\n`,
    `<table>\n\\[label](${signed}(note))\n`,
    `<table>\n![image](${signed}（保留）\n`,
  ])(
    'HTMLブロック内でも開き括弧か閉じ括弧を欠く記法は範囲を確定しない: %s',
    (input) => {
      expect(replaceRetainedSignedUrls(input)).toEqual({
        markdown: input,
        replacedCount: 0,
        boundaryUndeterminedCount: 1,
        unparseableSignedUrlCount: 0,
      });
    },
  );

  it('HTMLブロックの引用符付き属性値は範囲を確定する', () => {
    const input = `<table>\n<img src="${signed}">\n`;
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: `<table>\n<img src="${stable}">\n`,
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it.each([
    `foo](${signed}(note))\n`,
    `\\[label](${signed}(note))\n`,
    ['```text', `foo](${signed}(note))`, '```', ''].join('\n'),
  ])('Markdownリンクとして成立しない`](`は範囲を確定しない: %s', (input) => {
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 1,
      unparseableSignedUrlCount: 0,
    });
  });

  it.each([
    '<img src="https://file.notion.so/a?foo=1&#38;X-Amz-Signature=secret">',
    '<img src="https://file.notion.so/a?foo=1&#x26;X-Amz-Signature=secret">',
  ])('HTML属性の数値文字参照で区切られた署名keyを検出する: %s', (input) => {
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '<img src="https://file.notion.so/a">',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it.each([
    `[こちら](${signed}（保留）\n`,
    `[a](${signed} 続き\n`,
    `![i](${signed}\n次の行\n`,
  ])(
    'destinationが閉じ括弧を持たない場合は範囲を確定できず停止する: %s',
    (input) => {
      expect(replaceRetainedSignedUrls(input)).toEqual({
        markdown: input,
        replacedCount: 0,
        boundaryUndeterminedCount: 1,
        unparseableSignedUrlCount: 0,
      });
    },
  );

  it.each([
    signed,
    `${signed}（保留）`,
    `${signed}。次の文`,
    `${signed}.`,
    'https://file.notion.so/a.png?Signature=x(note)',
    'https://file.notion.so/a.png?Signature=x**bold**',
    'https://file.notion.so/a.png?Signature=xnext',
  ])(
    '空白を含まない単一値でも構文で範囲を確定できなければ停止する: %s',
    (input) => {
      expect(replaceRetainedSignedUrls(input)).toEqual({
        markdown: input,
        replacedCount: 0,
        boundaryUndeterminedCount: 1,
        unparseableSignedUrlCount: 0,
      });
    },
  );

  it.each(['.', ',', ';', ':', '!', '?'])(
    '文末記号 %s が続く裸URLは範囲を確定できず停止する',
    (punctuation) => {
      const input = `${signed}${punctuation} `;
      expect(replaceRetainedSignedUrls(input)).toEqual({
        markdown: input,
        replacedCount: 0,
        boundaryUndeterminedCount: 1,
        unparseableSignedUrlCount: 0,
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

  it('hostnameの末尾dotをラベル境界を保ったまま許可する', () => {
    expect(
      replaceRetainedSignedUrls(
        '![image](https://file.notion.so./file.png?Signature=value)',
      ),
    ).toEqual({
      markdown: '![image](https://file.notion.so./file.png)',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('hostnameの末尾dotを持つ解析不能URLをNotion由来として安全停止対象にする', () => {
    const input = 'https://file.notion.so./file.png?Signature=% ';

    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 0,
      unparseableSignedUrlCount: 1,
    });
  });

  it('コードフェンス内とinline code内のURLは停止し外側のdestinationだけ変換する', () => {
    const input = [
      '```md',
      signed,
      '```',
      '',
      `\`${signed}\``,
      '',
      `![image](${signed})`,
      '',
    ].join('\n');
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: [
        '```md',
        signed,
        '```',
        '',
        `\`${signed}\``,
        '',
        `![image](${stable})`,
        '',
      ].join('\n'),
      replacedCount: 1,
      boundaryUndeterminedCount: 2,
      unparseableSignedUrlCount: 0,
    });
  });

  it.each([
    '、後ろ',
    '。後ろ',
    'です',
    '（後ろ）',
    '(note)',
    '(補足)',
    '**bold**',
    '_italic_',
    'next',
    '-next',
    '}',
  ])('本文が密着する裸URLは置換せず停止する: %s', (trailing) => {
    const input = `前段 ${signed}${trailing} 後段\n`;
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 1,
      unparseableSignedUrlCount: 0,
    });
  });

  it('リンクテキストに置かれた裸URLは停止させる', () => {
    const input = `[${signed}](https://example.com)\n`;
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 1,
      unparseableSignedUrlCount: 0,
    });
  });

  it('destinationに置かれた非ASCII pathの署名URLを変換する', () => {
    const input = '![image](https://file.notion.so/画像.png?Signature=value)\n';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '![image](https://file.notion.so/%E7%94%BB%E5%83%8F.png)\n',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it('裸の非ASCII pathの署名URLを見逃さず停止させる', () => {
    const input = '前段 https://file.notion.so/画像.png?Signature=value です\n';
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 1,
      unparseableSignedUrlCount: 0,
    });
  });

  it('空白で区切られた複数の裸URLをそれぞれ停止対象に数える', () => {
    const another = 'https://cdn.notion-static.com/another.pdf?Expires=123';
    const input = `${signed} ${another} `;
    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: input,
      replacedCount: 0,
      boundaryUndeterminedCount: 2,
      unparseableSignedUrlCount: 0,
    });
  });

  it('同一URLと異なるURLを出現単位で数える', () => {
    const another = 'https://cdn.notion-static.com/another.pdf?Expires=123';
    const input = [
      `![a](${signed})`,
      `![b](${signed})`,
      `![c](${another})`,
      '![d](https://example.com/?signature=keep)',
      '',
    ].join('\n');

    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: [
        `![a](${stable})`,
        `![b](${stable})`,
        '![c](https://cdn.notion-static.com/another.pdf)',
        '![d](https://example.com/?signature=keep)',
        '',
      ].join('\n'),
      replacedCount: 3,
      ...noUnsafeUrls,
    });
  });

  it('AWS署名の補助parameterを含むNotion URLをMarkdown境界で安定参照へ変換する', () => {
    const input =
      '![image](https://file.notion.so/document.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=example%2F20260730%2Fregion%2Fs3%2Faws4_request&X-Amz-Date=20260730T000000Z&X-Amz-Expires=3600&X-Amz-Security-Token=placeholder&X-Amz-Signature=placeholder&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject)';

    expect(replaceRetainedSignedUrls(input)).toEqual({
      markdown: '![image](https://file.notion.so/document.png)',
      replacedCount: 1,
      ...noUnsafeUrls,
    });
  });

  it.each([
    `${signed},next `,
    `${signed}&next `,
    `${signed}&redirect=https://example.com `,
    `${signed};https://example.com `,
  ])('構文で範囲を確定できないNotion URLは変更しない: %s', (input) => {
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

  it.each([
    ['destination', (url: string) => `![image](${url})`],
    ['angle destination', (url: string) => `[link](<${url}>)`],
    ['autolink', (url: string) => `<${url}>`],
    ['HTML属性値', (url: string) => `<img src="${url}">`],
  ])(
    '%s を囲む前後の本文をbyte-for-byteで維持する',
    (_name, wrap: (url: string) => string) => {
      // 置換 span の外側が入力と一致することを、周辺文字列を変えながら固定する。
      // 乱数は再現可能にするため線形合同法で自前生成する（32bit に収める）。
      // scheme を偶然作らないよう、周辺文字列には英字を混ぜない。
      const characters = [...'()[]{}<>*_`"\'=#?&,.;:!-\\/ \n\tあ、。（）【】'];
      let seed = 20260731;
      const nextCharacter = (): string => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 1;
        return characters[seed % characters.length]!;
      };
      const randomText = (length: number): string =>
        Array.from({ length }, nextCharacter).join('');

      let replacedIterations = 0;
      for (let iteration = 0; iteration < 200; iteration += 1) {
        const prefix = randomText(iteration % 17);
        const suffix = randomText(iteration % 13);
        const input = `${prefix}${wrap(signed)}${suffix}`;
        const result = replaceRetainedSignedUrls(input);
        if (result.replacedCount > 0) replacedIterations += 1;

        // 周辺文字列がMarkdownの構造を変えると停止側へ倒れるため、置換の有無は問わない。
        // どちらに倒れてもURL以外の文字が失われないことを固定する。
        expect(result.markdown).toBe(
          result.replacedCount > 0
            ? `${prefix}${wrap(stable)}${suffix}`
            : input,
        );
      }

      // すべて停止側へ倒れる実装でも上の assert は通ってしまうため、置換が起きたことも固定する。
      expect(replacedIterations).toBeGreaterThan(0);
    },
  );

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
