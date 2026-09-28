/**
 * Line-based markdown chunking with overlap, sized like OpenClaw's memory
 * index: ~400 tokens per chunk and ~80 tokens carried into the next, at the
 * usual ~4 characters per token.
 */

export const CHUNK_MAX_CHARS = 1_600;
export const CHUNK_OVERLAP_CHARS = 320;

export interface MemoryChunk {
  index: number;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  text: string;
}

interface Line {
  number: number;
  text: string;
}

/** Splits one over-long line so no chunk exceeds the budget. */
function explodeLongLines(lines: Line[], maxChars: number): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    if (line.text.length <= maxChars) {
      out.push(line);
      continue;
    }
    for (let offset = 0; offset < line.text.length; offset += maxChars) {
      out.push({ number: line.number, text: line.text.slice(offset, offset + maxChars) });
    }
  }
  return out;
}

function lineCost(line: Line): number {
  return line.text.length + 1;
}

export function chunkMarkdown(
  body: string,
  options: { maxChars?: number; overlapChars?: number } = {},
): MemoryChunk[] {
  const maxChars = options.maxChars ?? CHUNK_MAX_CHARS;
  const overlapChars = Math.min(options.overlapChars ?? CHUNK_OVERLAP_CHARS, Math.floor(maxChars / 2));
  const lines = explodeLongLines(
    body.split("\n").map((text, i) => ({ number: i + 1, text })),
    maxChars,
  );

  const chunks: MemoryChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lineCost(lines[end]!) <= maxChars)) {
      size += lineCost(lines[end]!);
      end += 1;
    }
    const slice = lines.slice(start, end);
    const text = slice.map((line) => line.text).join("\n");
    if (text.trim()) {
      chunks.push({
        index: chunks.length,
        startLine: slice[0]!.number,
        endLine: slice[slice.length - 1]!.number,
        text,
      });
    }
    if (end >= lines.length) break;

    // Step back over trailing lines worth up to `overlapChars`, always
    // advancing at least one line so the loop terminates.
    let next = end;
    let carried = 0;
    while (next - 1 > start && carried + lineCost(lines[next - 1]!) <= overlapChars) {
      next -= 1;
      carried += lineCost(lines[next]!);
    }
    start = next;
  }
  return chunks;
}
