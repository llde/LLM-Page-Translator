import { describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({ default: {} }));

import { LANGUAGES } from '../src/shared/languages';
import { effectiveConfig, DEFAULT_SETTINGS, normalizeGlobal } from '../src/shared/settings';

describe('default model', () => {
  it('is empty and the legacy "llama3.1" default is cleared', () => {
    expect(DEFAULT_SETTINGS.model).toBe('');
    expect(normalizeGlobal(undefined).model).toBe('');
    expect(normalizeGlobal({ model: 'llama3.1' }).model).toBe('');
    expect(normalizeGlobal({ model: 'llama3.1:latest' }).model).toBe('llama3.1:latest');
  });
});

describe('LANGUAGES', () => {
  it('contains common languages without duplicates', () => {
    for (const l of ['English', 'Italian', 'Spanish', 'French', 'German', 'Chinese (Simplified)', 'Japanese']) {
      expect(LANGUAGES).toContain(l);
    }
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);
  });

  it('includes the default target language', () => {
    expect(LANGUAGES).toContain(DEFAULT_SETTINGS.targetLanguage);
  });
});

describe('effectiveConfig source language', () => {
  it('defaults to auto-detect and takes the tab override', () => {
    expect(effectiveConfig(DEFAULT_SETTINGS, {}).sourceLanguage).toBe('');
    expect(effectiveConfig(DEFAULT_SETTINGS, { sourceLanguage: 'German' }).sourceLanguage).toBe('German');
  });
});
