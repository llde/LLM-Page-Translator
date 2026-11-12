import { describe, expect, it } from 'vitest';
import { findTabPromptRule, makeTabPromptRule, resolveTabPrompt, tabPromptRulePrefixes } from '../src/shared/tabPromptRules';

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
