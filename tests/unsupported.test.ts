import { describe, expect, it } from 'vitest';
import {
  preserveUnsupportedBlock,
  unsupportedBlockPlaceholder,
} from '../src/transform/unsupported.js';

describe('unsupported block preservation', () => {
  it('可読な placeholder と復元可能な payload を返す', () => {
    const payload = { id: 'block-id', type: 'mystery', mystery: { value: 1 } };

    expect(unsupportedBlockPlaceholder('mystery', 'block-id')).toBe(
      '[Unsupported block: mystery]\n<!-- notion-to-obsidian: unsupported block type=mystery id=block-id -->',
    );
    expect(preserveUnsupportedBlock('mystery', 'block-id', payload)).toEqual({
      type: 'mystery',
      id: 'block-id',
      payload,
    });
  });
});
