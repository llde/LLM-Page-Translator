import { describe, expect, it } from 'vitest';
import { splitOversized, splitPhrases } from '../src/shared/phrases';

describe('splitPhrases', () => {
  it('splits sentences and preserves the original text', () => {
    expect(splitPhrases('Hello world. How are you? Fine.')).toEqual(['Hello world. ', 'How are you? ', 'Fine.']);
  });

  it('keeps whitespace-only input intact', () => {
    expect(splitPhrases('  ').join('')).toBe('  ');
  });

  it('merges leading whitespace into the first phrase', () => {
    const t = '\n   First one. Second one.';
    const p = splitPhrases(t);
    expect(p.join('')).toBe(t);
    expect(p.every((x) => x.trim().length > 0)).toBe(true);
  });
});

describe('splitOversized', () => {
  it('splits on sub-phrase punctuation within limit', () => {
    const s = 'alpha beta, gamma delta; epsilon zeta: eta theta';
    const parts = splitOversized(s, 20);
    expect(parts.join('')).toBe(s);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p) => expect(p.trim().length).toBeLessThanOrEqual(20));
    expect(parts[0]).toBe('alpha beta, ');
  });

  it('falls back to word boundaries', () => {
    const s = 'one two three four five six seven eight nine ten';
    const parts = splitOversized(s, 15);
    expect(parts.join('')).toBe(s);
    parts.forEach((p) => expect(p.trim().length).toBeLessThanOrEqual(15));
  });

  it('hard-cuts words longer than the limit', () => {
    const parts = splitOversized('a'.repeat(25), 10);
    expect(parts.join('')).toBe('a'.repeat(25));
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(10));
  });

  it('packs small sub-phrases together greedily', () => {
    const s = 'a, b, c, d';
    expect(splitOversized(s, 100)).toEqual([s]);
  });
});
