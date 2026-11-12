import { describe, expect, it } from 'vitest';
import { buildChunks } from '../src/shared/chunker';

describe('buildChunks', () => {
  it('starts a new chunk when the next phrase would exceed the limit', () => {
    const segs = [
      { id: 1, text: 'a'.repeat(200) },
      { id: 2, text: 'b'.repeat(300) },
      { id: 3, text: 'c'.repeat(100) },
    ];
    expect(buildChunks(segs, 512).map((c) => c.segmentIds)).toEqual([[1, 2], [3]]);
  });

  it('isolates oversized phrases as their own oversized chunk', () => {
    expect(buildChunks([{ id: 1, text: 'x'.repeat(600) }, { id: 2, text: 'y' }], 512)).toEqual([
      { segmentIds: [1], size: 600, oversized: true },
      { segmentIds: [2], size: 1, oversized: false },
    ]);
  });

  it('closes the current chunk before an oversized phrase', () => {
    const r = buildChunks([{ id: 1, text: 'a' }, { id: 2, text: 'x'.repeat(20) }, { id: 3, text: 'b' }], 10);
    expect(r.map((c) => [c.segmentIds, c.oversized])).toEqual([[[1], false], [[2], true], [[3], false]]);
  });

  it('allows a phrase exactly at the limit', () => {
    expect(buildChunks([{ id: 1, text: 'a'.repeat(512) }], 512)[0].oversized).toBe(false);
  });

  it('measures trimmed length', () => {
    const r = buildChunks([{ id: 1, text: '  aaaaa  ' }, { id: 2, text: ' bbbbb ' }], 10);
    expect(r).toEqual([{ segmentIds: [1, 2], size: 10, oversized: false }]);
  });

  it('starts a new chunk when consecutive multiword text changes DOM depth', () => {
    const r = buildChunks(
      [
        { id: 1, text: 'First paragraph.', domLevel: 1 },
        { id: 2, text: 'Second paragraph.', domLevel: 1 },
        { id: 3, text: 'Nested phrase here.', domLevel: 2 },
        { id: 4, text: 'Another nested phrase.', domLevel: 2 },
        { id: 5, text: 'Next paragraph.', domLevel: 1 },
      ],
      100,
    );
    expect(r.map((c) => c.segmentIds)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('allows one-word segments from another DOM depth inside the current batch', () => {
    const r = buildChunks(
      [
        { id: 1, text: 'First paragraph.', domLevel: 1 },
        { id: 2, text: 'One', domLevel: 2 },
        { id: 3, text: 'Second paragraph.', domLevel: 1 },
        { id: 4, text: 'Nested phrase here.', domLevel: 2 },
      ],
      100,
    );
    expect(r.map((c) => c.segmentIds)).toEqual([[1, 2, 3], [4]]);
  });
});
