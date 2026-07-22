import { describe, expect, it } from 'vitest';
import {
  convertDataSourceProperties,
  convertDataSourceProperty,
  resolveRelationProperty,
} from '../src/transform/data-source-properties.js';

describe('convertDataSourceProperty', () => {
  it.each([
    [
      'title',
      {
        type: 'title',
        title: [{ plain_text: 'Data ' }, { plain_text: 'row' }],
      },
      'Data row',
    ],
    [
      'rich_text',
      {
        type: 'rich_text',
        rich_text: [{ plain_text: 'Rich' }, { plain_text: ' text' }],
      },
      'Rich text',
    ],
    ['number', { type: 'number', number: 42 }, 42],
    ['number(null)', { type: 'number', number: null }, null],
    [
      'select',
      { type: 'select', select: { name: 'Done', color: 'green' } },
      'Done',
    ],
    [
      'multi_select',
      {
        type: 'multi_select',
        multi_select: [
          { name: 'A', color: 'red' },
          { name: 'B', color: 'blue' },
        ],
      },
      ['A', 'B'],
    ],
    [
      'status',
      { type: 'status', status: { name: 'In progress', color: 'blue' } },
      'In progress',
    ],
    [
      'date',
      {
        type: 'date',
        date: {
          start: '2026-07-12',
          end: '2026-07-13',
          time_zone: 'Asia/Tokyo',
        },
      },
      { start: '2026-07-12', end: '2026-07-13', timeZone: 'Asia/Tokyo' },
    ],
    [
      'people',
      {
        type: 'people',
        people: [{ id: 'user-1', name: 'Alice', avatar_url: 'ignored' }],
      },
      [{ id: 'user-1', name: 'Alice' }],
    ],
    [
      'files',
      {
        type: 'files',
        files: [
          {
            name: 'external.pdf',
            type: 'external',
            external: { url: 'https://example.com/a.pdf' },
          },
          {
            name: 'notion.png',
            type: 'file',
            file: { url: 'https://files.example/b.png' },
          },
        ],
      },
      [
        { name: 'external.pdf', url: 'https://example.com/a.pdf' },
        { name: 'notion.png', url: 'https://files.example/b.png' },
      ],
    ],
    ['checkbox', { type: 'checkbox', checkbox: true }, true],
    ['url', { type: 'url', url: 'https://example.com' }, 'https://example.com'],
    [
      'email',
      { type: 'email', email: 'alice@example.com' },
      'alice@example.com',
    ],
    [
      'phone_number',
      { type: 'phone_number', phone_number: '+81-90-0000-0000' },
      '+81-90-0000-0000',
    ],
    [
      'formula',
      { type: 'formula', formula: { type: 'number', number: 12 } },
      { value: 12, raw: { type: 'number', number: 12 } },
    ],
    [
      'relation',
      {
        type: 'relation',
        relation: [{ id: '11111111-1111-1111-1111-111111111111' }],
      },
      {
        value: ['11111111-1111-1111-1111-111111111111'],
        raw: [{ id: '11111111-1111-1111-1111-111111111111' }],
      },
    ],
    [
      'rollup',
      {
        type: 'rollup',
        rollup: { type: 'number', number: 3, function: 'count' },
      },
      { value: 3, raw: { type: 'number', number: 3, function: 'count' } },
    ],
    [
      'created_time',
      { type: 'created_time', created_time: '2026-07-12T00:00:00.000Z' },
      '2026-07-12T00:00:00.000Z',
    ],
    [
      'created_by',
      { type: 'created_by', created_by: { id: 'user-1', name: 'Alice' } },
      { id: 'user-1', name: 'Alice' },
    ],
    [
      'last_edited_time',
      {
        type: 'last_edited_time',
        last_edited_time: '2026-07-12T01:00:00.000Z',
      },
      '2026-07-12T01:00:00.000Z',
    ],
    [
      'last_edited_by',
      { type: 'last_edited_by', last_edited_by: { id: 'user-2', name: 'Bob' } },
      { id: 'user-2', name: 'Bob' },
    ],
    [
      'unique_id',
      { type: 'unique_id', unique_id: { prefix: 'TASK', number: 123 } },
      'TASK-123',
    ],
  ])('%sを人間可読なYAML値へ変換する', (_type, property, expected) => {
    expect(convertDataSourceProperty(property)).toEqual(expected);
  });

  it('未知型はraw情報を保持する', () => {
    const property = { type: 'future_type', future_type: { nested: true } };
    expect(convertDataSourceProperty(property)).toEqual({
      type: 'future_type',
      raw: property,
    });
  });

  it('既知型でもshapeが不正ならraw情報を保持する', () => {
    const property = { type: 'title', title: { unexpected: true } };
    expect(convertDataSourceProperty(property)).toEqual({
      type: 'title',
      raw: property,
    });
  });

  it('複雑なformulaとrollup arrayは可読値とrawを保持する', () => {
    expect(
      convertDataSourceProperty({
        type: 'formula',
        formula: { type: 'date', date: { start: '2026-07-12', end: null } },
      }),
    ).toEqual({
      value: '2026-07-12',
      raw: { type: 'date', date: { start: '2026-07-12', end: null } },
    });
    expect(
      convertDataSourceProperty({
        type: 'rollup',
        rollup: {
          type: 'array',
          array: [
            { type: 'number', number: 1 },
            { type: 'number', number: 2 },
          ],
          function: 'show_original',
        },
      }),
    ).toEqual({
      value: [1, 2],
      raw: {
        type: 'array',
        array: [
          { type: 'number', number: 1 },
          { type: 'number', number: 2 },
        ],
        function: 'show_original',
      },
    });
  });
});

describe('convertDataSourceProperties', () => {
  const signedUrl =
    'https://file.notion.so/report.pdf?X-Amz-Signature=temporary#preview';
  const stableUrl = 'https://file.notion.so/report.pdf';

  it('file由来のURLだけをhostに依存せず安定化しexternal由来のsubtreeを維持する', () => {
    const externalUrl =
      'https://file.notion.so/external.pdf?X-Amz-Signature=keep';
    const properties = {
      Files: {
        type: 'files',
        files: [
          {
            name: 'Notion file',
            type: 'file',
            file: {
              url: 'https://cdn.example.test/file.pdf?token=temporary#page',
            },
          },
          {
            name: signedUrl,
            type: 'external',
            external: { url: externalUrl, caption: signedUrl },
          },
        ],
      },
    };
    const original = structuredClone(properties);

    const result = convertDataSourceProperties(properties, new Map());

    expect(result).toEqual({
      properties: {
        Files: [
          { name: 'Notion file', url: 'https://cdn.example.test/file.pdf' },
          { name: signedUrl, url: externalUrl },
        ],
      },
      replacedCount: 1,
    });
    expect(properties).toEqual(original);
  });

  it('formulaとrollupでvalueとrawへ複製されるfile URLを最終出力の出現数として数える', () => {
    const externalProtectedUrl =
      'https://file.notion.so/external.pdf?X-Amz-Signature=keep';
    const file = {
      type: 'file',
      file: { url: signedUrl, expiry_time: '2026-07-22T00:00:00.000Z' },
      preserved: true,
    };
    const external = {
      type: 'external',
      external: {
        url: externalProtectedUrl,
        nested: { example: externalProtectedUrl },
      },
    };
    const properties = {
      Formula: {
        type: 'formula',
        formula: { type: 'array', array: [file, external] },
      },
      Rollup: {
        type: 'rollup',
        rollup: { type: 'array', array: [file, external] },
      },
    };

    const result = convertDataSourceProperties(properties, new Map());

    expect(JSON.stringify(result.properties)).not.toContain(
      'X-Amz-Signature=temporary#preview',
    );
    expect(JSON.stringify(result.properties)).toContain(externalProtectedUrl);
    expect(result.replacedCount).toBe(4);
    expect(
      (result.properties.Formula as { raw: { array: unknown[] } }).raw.array[0],
    ).toEqual({
      type: 'file',
      file: {
        url: stableUrl,
        expiry_time: '2026-07-22T00:00:00.000Z',
      },
      preserved: true,
    });
  });

  it('未知shapeのrawにあるfileと署名文字列を安定化し外部URLと他フィールドを保全する', () => {
    const property = {
      type: 'future_type',
      future_type: {
        file: { type: 'file', file: { url: signedUrl }, color: 'blue' },
        external: {
          type: 'external',
          external: { url: signedUrl, nested: signedUrl },
        },
        bare: signedUrl,
        ordinary: 'https://example.com/a?Signature=keep',
      },
    };

    const result = convertDataSourceProperties({ Future: property }, new Map());

    expect(result.replacedCount).toBe(2);
    expect(result.properties).toEqual({
      Future: {
        type: 'future_type',
        raw: {
          type: 'future_type',
          future_type: {
            file: {
              type: 'file',
              file: { url: stableUrl },
              color: 'blue',
            },
            external: property.future_type.external,
            bare: stableUrl,
            ordinary: 'https://example.com/a?Signature=keep',
          },
        },
      },
    });
  });

  it('titleに残った署名URLを安定化する', () => {
    const result = convertDataSourceProperties(
      {
        Name: {
          type: 'title',
          title: [{ plain_text: `Reference ${signedUrl}` }],
        },
      },
      new Map(),
    );

    expect(result).toEqual({
      properties: { Name: `Reference ${stableUrl}` },
      replacedCount: 1,
    });
  });
});

describe('resolveRelationProperty', () => {
  it('同期対象IDだけWikiLinkにし、対象外IDは保持する', () => {
    const synced = '11111111-1111-1111-1111-111111111111';
    const external = '22222222-2222-2222-2222-222222222222';
    expect(
      resolveRelationProperty(
        { type: 'relation', relation: [{ id: synced }, { id: external }] },
        new Map([[synced, 'Folder/Page.md']]),
      ),
    ).toEqual({
      value: ['[[Folder/Page]]', external],
      raw: [{ id: synced }, { id: external }],
    });
  });

  it('relationが未完走である情報を保持する', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(
      resolveRelationProperty(
        {
          type: 'relation',
          relation: [{ id, future_field: 'keep' }],
          has_more: true,
        },
        new Map(),
      ),
    ).toEqual({
      value: [id],
      raw: [{ id, future_field: 'keep' }],
      hasMore: true,
    });
  });
});
