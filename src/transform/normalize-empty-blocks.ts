type Fence = {
  marker: '`' | '~';
  length: number;
};

const emptyBlockPattern = /^<empty-block\/>[ \t]*$/u;
const blankLinePattern = /^[ \t]*$/u;
const openingFencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const closingFencePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;

function openingFence(line: string): Fence | undefined {
  const match = openingFencePattern.exec(line);
  if (!match) return undefined;
  const run = match[1]!;
  const suffix = match[2]!;
  const marker = run[0] as Fence['marker'];
  if (marker === '`' && suffix.includes('`')) return undefined;
  return { marker, length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = closingFencePattern.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence.marker && run.length >= fence.length;
}

export function normalizeEmptyBlocks(markdown: string): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(lineEnding);
  const output: string[] = [];
  let fence: Fence | undefined;
  let gap: string[] = [];
  let gapHasEmptyBlock = false;
  let hasEmptyBlock = false;

  const flushGap = (hasFollowingLine: boolean): void => {
    if (gapHasEmptyBlock) {
      if (output.length > 0 && hasFollowingLine) output.push('');
    } else {
      output.push(...gap);
    }
    gap = [];
    gapHasEmptyBlock = false;
  };

  for (const line of lines) {
    if (fence) {
      flushGap(true);
      output.push(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }

    const openedFence = openingFence(line);
    if (openedFence) {
      flushGap(true);
      output.push(line);
      fence = openedFence;
      continue;
    }

    if (emptyBlockPattern.test(line)) {
      gap.push(line);
      gapHasEmptyBlock = true;
      hasEmptyBlock = true;
      continue;
    }
    if (blankLinePattern.test(line)) {
      gap.push(line);
      continue;
    }

    flushGap(true);
    output.push(line);
  }
  flushGap(false);

  return hasEmptyBlock ? output.join(lineEnding) : markdown;
}
