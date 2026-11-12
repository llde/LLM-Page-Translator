import { describe, expect, it } from 'vitest';
import { buildMessages, parseResponse, ParseError } from '../src/background/prompt';

describe('buildMessages', () => {
  const msgs = buildMessages(
    { systemPrompt: 'You are a translator.', tabPrompt: 'Medical article', targetLanguage: 'Italian' },
    [{ id: 1, text: '  Hello\n world. ' }, { id: 2, text: 'Bye.' }],
  );

  it('appends format instructions to the system prompt', () => {
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('You are a translator.');
    expect(msgs[0].content).toContain('<translated_text>');
    expect(msgs[0].content).toContain('add appropriate spaces after punctuation');
    expect(msgs[0].content).toContain('target language');
  });

  it('includes context, target language and numbered, normalized segments', () => {
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Medical article');
    expect(msgs[1].content).toContain('Italian');
    expect(msgs[1].content).toContain('[1] Hello world. [2] Bye.');
    expect(msgs[0].content).toContain('one continuous phrase');
  });
});

describe('source language', () => {
  const segs = [{ id: 1, text: 'Gift' }];
  it('is stated when set', () => {
    const m = buildMessages({ systemPrompt: '', tabPrompt: '', targetLanguage: 'English', sourceLanguage: 'German' }, segs);
    expect(m[1].content).toContain('Source language: German');
    expect(m[1].content.indexOf('Source language')).toBeLessThan(m[1].content.indexOf('Target language'));
  });

  it('is omitted when empty (auto-detect)', () => {
    const m = buildMessages({ systemPrompt: '', tabPrompt: '', targetLanguage: 'English', sourceLanguage: '' }, segs);
    expect(m[1].content).not.toContain('Source language');
    expect(buildMessages({ systemPrompt: '', tabPrompt: '', targetLanguage: 'English' }, segs)[1].content).not.toContain('Source language');
  });
});

describe('parseResponse', () => {
  it('parses numbered lines inside the tag, ignoring think blocks', () => {
    const raw = '<think>[1] nope</think>Sure!<translated_text>\n[1] Ciao\n[2] Mondo\n</translated_text>';
    expect(parseResponse(raw, [1, 2])).toEqual({ 1: 'Ciao', 2: 'Mondo' });
  });

  it('parses inline markers', () => {
    expect(parseResponse('<translated_text>[1] Ciao [2] Mondo</translated_text>', [1, 2])).toEqual({ 1: 'Ciao', 2: 'Mondo' });
  });

  it('maps inline phrase output back to each original segment reference', () => {
    expect(parseResponse('<translated_text>[104] 書いて [105] ください</translated_text>', [104, 105])).toEqual({
      104: '書いて',
      105: 'ください',
    });
  });

  it('ignores markers that are not expected ids', () => {
    expect(parseResponse('<translated_text>[3] Vedi [7] nota\n[4] Fine</translated_text>', [3, 4])).toEqual({
      3: 'Vedi [7] nota',
      4: 'Fine',
    });
  });

  it('throws on missing ids', () => {
    expect(() => parseResponse('<translated_text>[1] Ciao</translated_text>', [1, 2])).toThrow(ParseError);
  });

  it('throws when the tag is missing', () => {
    expect(() => parseResponse('[1] Ciao', [1])).toThrow(/translated_text/);
  });

  it('accepts a single segment without marker', () => {
    expect(parseResponse('<translated_text>\nCiao mondo\n</translated_text>', [5])).toEqual({ 5: 'Ciao mondo' });
  });

  it('uses the last tag block', () => {
    const raw = 'Example: <translated_text>[1] x</translated_text> Real: <translated_text>[1] Ciao</translated_text>';
    expect(parseResponse(raw, [1])).toEqual({ 1: 'Ciao' });
  });
});
