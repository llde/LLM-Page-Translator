import { describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({ default: {} }));

import { findTabPromptRule, makeTabPromptRule, resolveTabPrompt, tabPromptRulePrefixes } from '../src/shared/tabPromptRules';
import { normalizeGlobal } from '../src/shared/settings';

describe('memory retention setting', () => {
  it('defaults to 30 days and preserves a configured positive integer', () => {
    expect(normalizeGlobal(undefined).memoryRetentionDays).toBe(30);
    expect(normalizeGlobal({ memoryRetentionDays: 12 }).memoryRetentionDays).toBe(12);
  });

  it('normalizes invalid stored values to 30 days', () => {
    for (const memoryRetentionDays of [0, -1, 1.5, Number.NaN]) {
      expect(normalizeGlobal({ memoryRetentionDays }).memoryRetentionDays).toBe(30);
    }
  });
});

describe('saved tab prompt rules', () => {
  const rules = [
    { urlPrefix: 'https://ncode.syosetu.com/n3270iz/', prompt: 'Novel translation' },
    { urlPrefix: 'https://ncode.syosetu.com/n3270iz/special/', prompt: 'Special chapter' },
  ];

  it('creates a path-prefix rule without query or fragment', () => {
    expect(makeTabPromptRule('https://ncode.syosetu.com/n3270iz/?page=2#top', 'Novel translation')).toEqual({
      urlPrefix: 'https://ncode.syosetu.com/n3270iz/',
      prompt: 'Novel translation',
    });
  });

  it('lists the current URL path and each ancestor as save targets', () => {
    expect(tabPromptRulePrefixes('https://ncode.syosetu.com/n3270iz/51/?page=2#top')).toEqual([
      'https://ncode.syosetu.com/n3270iz/51/',
      'https://ncode.syosetu.com/n3270iz/',
      'https://ncode.syosetu.com/',
    ]);
  });

  it('matches descendant pages and chooses the most specific prefix', () => {
    expect(findTabPromptRule('https://ncode.syosetu.com/n3270iz/51/', rules)).toEqual(rules[0]);
    expect(findTabPromptRule('https://ncode.syosetu.com/n3270iz/special/2/', rules)).toEqual(rules[1]);
  });

  it('does not match sibling paths or another origin', () => {
    expect(findTabPromptRule('https://ncode.syosetu.com/n3270iz-extra/51/', rules)).toBeUndefined();
    expect(findTabPromptRule('http://ncode.syosetu.com/n3270iz/51/', rules)).toBeUndefined();
  });

  it('uses the per-tab prompt before the matching rule and global default', () => {
    expect(resolveTabPrompt('Tab context', 'Global context', 'https://ncode.syosetu.com/n3270iz/51/', rules)).toBe('Tab context');
    expect(resolveTabPrompt('', 'Global context', 'https://ncode.syosetu.com/n3270iz/51/', rules)).toBe('Novel translation');
    expect(resolveTabPrompt('', 'Global context', 'https://example.com/', rules)).toBe('Global context');
  });
});
