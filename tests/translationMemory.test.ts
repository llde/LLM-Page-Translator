import { afterEach, describe, expect, it, vi } from 'vitest';

const fakeStorage = vi.hoisted(() => {
  const items = new Map<string, unknown>();
  return {
    items,
    local: {
      async get(keys?: string | null) {
        if (keys == null) return Object.fromEntries(items);
        return items.has(keys) ? { [keys]: items.get(keys) } : {};
      },
      async set(values: Record<string, unknown>) {
        for (const [key, value] of Object.entries(values)) items.set(key, value);
      },
      async remove(keys: string | string[]) {
        for (const key of typeof keys === 'string' ? [keys] : keys) items.delete(key);
      },
    },
  };
});

vi.mock('webextension-polyfill', () => ({ default: { storage: { local: fakeStorage.local } } }));

import { DEFAULT_SETTINGS, effectiveConfig } from '../src/shared/settings';
import {
  clearPageTranslationMemory,
  getTranslationMemory,
  getTranslationMemoryIndex,
  setTranslationMemory,
  visitTranslationMemory,
  type TranslationMemoryContext,
} from '../src/shared/translationMemory';

const settings = effectiveConfig(DEFAULT_SETTINGS, {});
const indexedSettings = { ...settings, experimentalCachedTextContent: true };
const segments = [{ id: 1, text: 'Hello.' }, { id: 2, text: 'Goodbye.' }];
const translations = { 1: 'Ciao.', 2: 'Arrivederci.' };

type TestTranslationMemoryContext = TranslationMemoryContext & {
  frameId: number;
  frameUrl: string;
  frameUrlAncestry: string[];
};

function context(
  pageUrl: string,
  frameId = 0,
  frameUrl = pageUrl,
  frameUrlAncestry = frameUrl === pageUrl ? [pageUrl] : [pageUrl, frameUrl],
): TestTranslationMemoryContext {
  return { pageUrl, frameId, frameUrl, frameUrlAncestry };
}

afterEach(() => {
  fakeStorage.items.clear();
  vi.useRealTimers();
});

describe('translation memory', () => {
  it('only indexes newly cached source text when the experimental option is enabled', async () => {
    const page = 'https://example.com/opt-in';
    await setTranslationMemory(context(page), settings, segments, translations);
    await expect(getTranslationMemory(context(page), settings, segments)).resolves.toEqual(translations);
    expect(Object.values((await getTranslationMemoryIndex(context(page), indexedSettings)).entries)).toEqual([]);

    await expect(getTranslationMemory(context(page), indexedSettings, segments)).resolves.toEqual(translations);
    expect(Object.values((await getTranslationMemoryIndex(context(page), indexedSettings)).entries)).toEqual([
      { texts: ['Hello.', 'Goodbye.'], translations: ['Ciao.', 'Arrivederci.'] },
    ]);
  });

  it('preloads only chunks for the same page, frame ancestry, and translation settings', async () => {
    const page = 'https://example.com/article';
    const frame = context(page, 4, 'https://example.com/frame');
    await setTranslationMemory(context(page), indexedSettings, segments, translations);
    await setTranslationMemory(frame, indexedSettings, segments, { 1: 'Frame hello.', 2: 'Frame goodbye.' });
    await setTranslationMemory(context(page), { ...indexedSettings, targetLanguage: 'French' }, segments, { 1: 'Bonjour.', 2: 'Au revoir.' });
    await setTranslationMemory(context('https://example.com/other'), indexedSettings, segments, translations);

    const index = await getTranslationMemoryIndex(context(page), indexedSettings);
    expect(Object.values(index.entries)).toEqual([{ texts: ['Hello.', 'Goodbye.'], translations: ['Ciao.', 'Arrivederci.'] }]);
    const frameIndex = await getTranslationMemoryIndex(frame, indexedSettings);
    expect(Object.values(frameIndex.entries)).toEqual([{ texts: ['Hello.', 'Goodbye.'], translations: ['Frame hello.', 'Frame goodbye.'] }]);
    await clearPageTranslationMemory(page);
    expect(Object.values((await getTranslationMemoryIndex(context(page), indexedSettings)).entries)).toEqual([]);
  });

  it('indexes legacy hashed entries when they are read', async () => {
    const page = 'https://example.com/legacy';
    await setTranslationMemory(context(page), indexedSettings, segments, translations);
    const [key] = [...fakeStorage.items.keys()];
    fakeStorage.items.set(key, ['Ciao.', 'Arrivederci.']);

    await expect(getTranslationMemory(context(page), indexedSettings, segments)).resolves.toEqual(translations);
    expect(Object.values((await getTranslationMemoryIndex(context(page), indexedSettings)).entries)).toEqual([
      { texts: ['Hello.', 'Goodbye.'], translations: ['Ciao.', 'Arrivederci.'] },
    ]);
  });

  it('does not recreate a legacy entry when page memory is cleared during migration', async () => {
    const page = 'https://example.com/legacy-clear';
    await setTranslationMemory(context(page), indexedSettings, segments, translations);
    const [key] = [...fakeStorage.items.keys()];
    fakeStorage.items.set(key, ['Ciao.', 'Arrivederci.']);
    let resumeMigration!: () => void;
    let migrationStarted!: () => void;
    const started = new Promise<void>((resolve) => { migrationStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { resumeMigration = resolve; });
    const originalSet = fakeStorage.local.set;
    const setter = vi.spyOn(fakeStorage.local, 'set').mockImplementation(async (values) => {
      migrationStarted();
      await blocked;
      await originalSet(values);
    });

    try {
      const lookup = getTranslationMemory(context(page), indexedSettings, segments);
      await started;
      const clearing = clearPageTranslationMemory(page);
      await Promise.race([clearing, new Promise((resolve) => setTimeout(resolve, 50))]);
      resumeMigration();
      await Promise.all([lookup, clearing]);
      expect(fakeStorage.items.has(key)).toBe(false);
    } finally {
      resumeMigration();
      setter.mockRestore();
    }
  });

  it('allows identical-URL sibling frames under the same parent to share memory across frame IDs', async () => {
    const page = 'https://example.com/article';
    const frameUrl = 'https://example.com/embed';
    await setTranslationMemory(context(page, 4, frameUrl), settings, segments, translations);

    await expect(getTranslationMemory(context(page, 9, frameUrl), settings, segments)).resolves.toEqual(translations);
  });

  it('isolates frames with different URL ancestry even when their final frame URLs match', async () => {
    const page = 'https://example.com/article';
    const frameUrl = 'https://example.com/embed';
    await setTranslationMemory(
      context(page, 4, frameUrl, [page, 'https://example.com/parent-a', frameUrl]),
      settings,
      segments,
      translations,
    );

    await expect(
      getTranslationMemory(
        context(page, 4, frameUrl, [page, 'https://example.com/parent-b', frameUrl]),
        settings,
        segments,
      ),
    ).resolves.toBeUndefined();
  });

  it('reuses a saved chunk with current segment IDs but isolates another frame', async () => {
    const page = 'https://example.com/article';
    await setTranslationMemory(context(page), settings, segments, translations);

    await expect(
      getTranslationMemory(context(page), settings, [
        { id: 12, text: 'Hello.' },
        { id: 13, text: 'Goodbye.' },
      ]),
    ).resolves.toEqual({ 12: 'Ciao.', 13: 'Arrivederci.' });
    await expect(
      getTranslationMemory(context(page, 4, 'https://example.com/embed'), settings, segments),
    ).resolves.toBeUndefined();
  });

  it('does not reuse a chunk when the translation prompt or target language changes', async () => {
    const page = 'https://example.com/article';
    await setTranslationMemory(context(page), settings, segments, translations);

    const prompted = effectiveConfig(DEFAULT_SETTINGS, { tabPrompt: 'Use a formal tone.' });
    const french = effectiveConfig(DEFAULT_SETTINGS, { targetLanguage: 'French' });
    const differentProvider = { ...settings, provider: 'openai' as const };
    await expect(getTranslationMemory(context(page), settings, segments)).resolves.toEqual(translations);
    await expect(getTranslationMemory(context(page), prompted, segments)).resolves.toBeUndefined();
    await expect(getTranslationMemory(context(page), french, segments)).resolves.toBeUndefined();
    await expect(getTranslationMemory(context(page), differentProvider, segments)).resolves.toBeUndefined();
  });

  it('expires every frame of an inactive page and retains a recently visited page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const oldPage = 'https://example.com/old';
    await visitTranslationMemory(oldPage, 30);
    await setTranslationMemory(context(oldPage), settings, segments, translations);
    await setTranslationMemory(context(oldPage, 2, 'https://example.com/old-frame'), settings, segments, translations);

    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'));
    const recentPage = 'https://example.com/recent';
    await visitTranslationMemory(recentPage, 30);
    await setTranslationMemory(context(recentPage), settings, segments, translations);

    vi.setSystemTime(new Date('2026-02-02T00:00:00Z'));
    await expect(visitTranslationMemory(recentPage, 30)).resolves.toEqual({
      expiredPages: 1,
      expiredEntries: 2,
    });
    await expect(getTranslationMemory(context(oldPage), settings, segments)).resolves.toBeUndefined();
    await expect(
      getTranslationMemory(context(oldPage, 2, 'https://example.com/old-frame'), settings, segments),
    ).resolves.toBeUndefined();
    await expect(getTranslationMemory(context(recentPage), settings, segments)).resolves.toEqual(translations);
  });

  it('clears all frame memories for one page without clearing another page', async () => {
    const page = 'https://example.com/article';
    const otherPage = 'https://example.com/another';
    await visitTranslationMemory(page, 30);
    await setTranslationMemory(context(page), settings, segments, translations);
    await setTranslationMemory(context(page, 3, 'https://example.com/embed'), settings, segments, translations);
    await setTranslationMemory(context(otherPage), settings, segments, translations);

    await expect(clearPageTranslationMemory(page)).resolves.toEqual({ removedEntries: 2 });

    await expect(getTranslationMemory(context(page), settings, segments)).resolves.toBeUndefined();
    await expect(
      getTranslationMemory(context(page, 3, 'https://example.com/embed'), settings, segments),
    ).resolves.toBeUndefined();
    await expect(getTranslationMemory(context(otherPage), settings, segments)).resolves.toEqual(translations);
  });
});
