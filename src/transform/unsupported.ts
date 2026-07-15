export interface UnsupportedSidecar {
  type: string;
  id: string;
  payload: unknown;
}

function safeCommentValue(value: string): string {
  return value.replaceAll('--', '-').replaceAll('>', '');
}

export function unsupportedBlockPlaceholder(type: string, id: string): string {
  const safeType = safeCommentValue(type);
  const safeId = safeCommentValue(id);
  return `[Unsupported block: ${safeType}]\n<!-- notion-to-obsidian: unsupported block type=${safeType} id=${safeId} -->`;
}

export function preserveUnsupportedBlock(
  type: string,
  id: string,
  payload: unknown,
): UnsupportedSidecar {
  return { type, id, payload };
}
