/**
 * Phrase utilities. All functions are lossless: joining the returned pieces yields the input.
 */

const SENTENCE_FALLBACK = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*\s*|$)/g;

function rawSentences(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: 'sentence' });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  const out = text.match(SENTENCE_FALLBACK) ?? [];
  const joined = out.join('');
  // Fallback regex might drop leading whitespace; repair to stay lossless.
  if (joined !== text) return [text];
  return out;
}

/** Merge whitespace-only pieces into neighbours so every piece has visible text. */
function mergeBlank(pieces: string[]): string[] {
  const out: string[] = [];
  let pendingLead = '';
  for (const p of pieces) {
    if (!p) continue;
    if (p.trim() === '') {
      if (out.length) out[out.length - 1] += p;
      else pendingLead += p;
      continue;
    }
    out.push(pendingLead + p);
    pendingLead = '';
  }
  if (pendingLead) {
    if (out.length) out[out.length - 1] += pendingLead;
    else out.push(pendingLead);
  }
  return out;
}

/** Split a text into sentence-like phrases. */
export function splitPhrases(text: string): string[] {
  if (!text) return [];
  return mergeBlank(rawSentences(text));
}

/** Greedily pack consecutive parts so that each packed piece's trimmed length is <= max. */
function pack(parts: string[], max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).trim().length > max) {
      out.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function splitKeep(text: string, re: RegExp): string[] {
  return text.split(re).filter((s) => s !== '');
}

function hardCut(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/**
 * Split an oversized phrase into pieces whose trimmed length is <= max.
 * Order of preference: after `, ; :` (and full-width variants), then word boundaries, then hard cut.
 */
export function splitOversized(text: string, max: number): string[] {
  if (max < 1) throw new Error('max must be >= 1');
  if (text.trim().length <= max) return [text];

  const levels: ((t: string) => string[])[] = [
    (t) => splitKeep(t, /(?<=[,;:，；：]\s*)(?=\S)/),
    (t) => splitKeep(t, /(?<=\s)(?=\S)/),
    (t) => hardCut(t, max),
  ];

  const recurse = (t: string, level: number): string[] => {
    if (t.trim().length <= max) return [t];
    if (level >= levels.length) return [t];
    const parts = levels[level](t).flatMap((p) => (p.trim().length > max ? recurse(p, level + 1) : [p]));
    return pack(parts, max);
  };

  return mergeBlank(recurse(text, 0));
}
