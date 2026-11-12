import type { SegmentPayload } from './types';

const wordSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : undefined;

export interface ChunkPlan {
  segmentIds: number[];
  /** Sum of trimmed segment lengths (characters). */
  size: number;
  /** True when a single phrase alone exceeds the max size; such chunks are not sent automatically. */
  oversized: boolean;
}

function isSingleWord(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!wordSegmenter) return trimmed.split(/\s+/).length === 1;
  let words = 0;
  for (const part of wordSegmenter.segment(trimmed)) {
    if (part.isWordLike && ++words > 1) return false;
  }
  return words === 1;
}

/**
 * Group phrases (in reading order and at the same DOM depth) into chunks of at most `max` characters.
 * Single-word phrases do not constrain the DOM depth of their chunk.
 * A phrase is never split here: if it does not fit in the current chunk it starts a new one,
 * and if it does not fit in an empty chunk it becomes an oversized chunk on its own.
 */
export function buildChunks(segs: SegmentPayload[], max: number): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  let cur: ChunkPlan | null = null;
  let curDepth: number | undefined;
  for (const s of segs) {
    const len = s.text.trim().length;
    if (len === 0) continue;
    if (len > max) {
      if (cur) out.push(cur);
      cur = null;
      curDepth = undefined;
      out.push({ segmentIds: [s.id], size: len, oversized: true });
      continue;
    }
    const singleWord = isSingleWord(s.text);
    const depth = s.domLevel ?? 0;
    if (!singleWord && cur && curDepth !== undefined && curDepth !== depth) {
      out.push(cur);
      cur = null;
      curDepth = undefined;
    }
    if (cur && cur.size + len > max) {
      out.push(cur);
      cur = null;
      curDepth = undefined;
    }
    if (!cur) cur = { segmentIds: [], size: 0, oversized: false };
    if (!singleWord && curDepth === undefined) curDepth = depth;
    cur.segmentIds.push(s.id);
    cur.size += len;
  }
  if (cur) out.push(cur);
  return out;
}
