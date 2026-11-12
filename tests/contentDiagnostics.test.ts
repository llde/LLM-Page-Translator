import { describe, expect, it } from 'vitest';
import { analyzeMutationBatch } from '../src/content/diagnostics';

describe('content diagnostics', () => {
  it('short-circuits relevance checks when diagnostics are disabled', () => {
    const checked: number[] = [];
    const result = analyzeMutationBatch(
      [1, 2, 3],
      (record) => {
        checked.push(record);
        return record === 1;
      },
      false,
    );

    expect(result).toEqual({ hasRelevantRecords: true });
    expect(checked).toEqual([1]);
  });
});
