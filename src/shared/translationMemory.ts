import { browser } from './browser';
import type { EffectiveSettings } from './settings';
import type { SegmentPayload } from './types';

const PREFIX = 'llm-page-translator:memory:v1';
const PAGE_PREFIX = `${PREFIX}:page:`;
const ENTRY_PREFIX = `${PREFIX}:entry:`;
const DAY_MS = 24 * 60 * 60 * 1000;

let pendingWrite = Promise.resolve();

async function withMemoryWrite<T>(operation: () => Promise<T>): Promise<T> {
  const previous = pendingWrite;
  let release!: () => void;
  pendingWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export interface TranslationMemoryContext {
  pageUrl: string;
  frameUrlAncestry: string[];
}

export interface IndexedTranslation {
  texts: string[];
  translations: string[];
}

export interface TranslationMemoryIndex {
  prefix: string;
  scope: string;
  entries: Record<string, IndexedTranslation>;
}

interface StoredTranslation extends IndexedTranslation {
  scope: string;
}

export function isStoredTranslation(value: unknown): value is StoredTranslation {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredTranslation>;
  return typeof entry.scope === 'string' && Array.isArray(entry.texts) && Array.isArray(entry.translations) &&
    entry.texts.length === entry.translations.length &&
    entry.texts.every((text) => typeof text === 'string') &&
    entry.translations.every((translation) => typeof translation === 'string');
}

function normalizeUrl(url: string): string {
  return new URL(url).href;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function translationSettings(settings: EffectiveSettings) {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    contextWindow: settings.contextWindow,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    systemPrompt: settings.systemPrompt,
    tabPrompt: settings.tabPrompt,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
  };
}

async function pageHash(pageUrl: string): Promise<string> {
  return hash(normalizeUrl(pageUrl));
}

async function scopeHash(context: TranslationMemoryContext, settings: EffectiveSettings): Promise<string> {
  return hash(JSON.stringify({
    frameUrlAncestry: context.frameUrlAncestry.map(normalizeUrl),
    settings: translationSettings(settings),
  }));
}

export async function getTranslationMemoryIndex(
  context: TranslationMemoryContext,
  settings: EffectiveSettings,
): Promise<TranslationMemoryIndex> {
  const prefix = `${ENTRY_PREFIX}${await pageHash(context.pageUrl)}:`;
  const scope = await scopeHash(context, settings);
  const stored = await browser.storage.local.get(null);
  const entries: Record<string, IndexedTranslation> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(prefix) && isStoredTranslation(value) && value.scope === scope) {
      entries[key] = { texts: value.texts, translations: value.translations };
    }
  }
  return { prefix, scope, entries };
}

async function entryKey(
  context: TranslationMemoryContext,
  settings: EffectiveSettings,
  segments: readonly SegmentPayload[],
): Promise<string> {
  const page = await pageHash(context.pageUrl);
  const identity = JSON.stringify({
    frameUrlAncestry: context.frameUrlAncestry.map(normalizeUrl),
    settings: translationSettings(settings),
    text: segments.map((segment) => segment.text),
  });
  return `${ENTRY_PREFIX}${page}:${await hash(identity)}`;
}

export async function getTranslationMemory(
  context: TranslationMemoryContext,
  settings: EffectiveSettings,
  segments: readonly SegmentPayload[],
): Promise<Record<number, string> | undefined> {
  const key = await entryKey(context, settings, segments);
  const stored = await browser.storage.local.get(key);
  const entry = stored[key];
  const values = isStoredTranslation(entry) ? entry.translations : entry;
  if (!Array.isArray(values) || values.length !== segments.length || !values.every((value) => typeof value === 'string')) {
    return undefined;
  }
  if (Array.isArray(entry) && settings.experimentalCachedTextContent) {
    const scope = await scopeHash(context, settings);
    await withMemoryWrite(async () => {
      const current = (await browser.storage.local.get(key))[key];
      if (!Array.isArray(current) || current.length !== values.length ||
        current.some((value, index) => value !== values[index])) return;
      await browser.storage.local.set({
        [key]: { scope, texts: segments.map((segment) => segment.text), translations: values },
      });
    });
  }
  return Object.fromEntries(segments.map((segment, index) => [segment.id, values[index]]));
}

export async function setTranslationMemory(
  context: TranslationMemoryContext,
  settings: EffectiveSettings,
  segments: readonly SegmentPayload[],
  translations: Record<number, string>,
): Promise<void> {
  const values = segments.map((segment) => {
    const translation = translations[segment.id];
    if (typeof translation !== 'string') throw new Error(`Missing translation for segment ${segment.id}`);
    return translation;
  });
  const key = await entryKey(context, settings, segments);
  const indexed = settings.experimentalCachedTextContent
    ? { scope: await scopeHash(context, settings), texts: segments.map((segment) => segment.text), translations: values }
    : values;
  await withMemoryWrite(async () => {
    await browser.storage.local.set({ [key]: indexed });
  });
}

export async function visitTranslationMemory(
  pageUrl: string,
  retentionDays: number,
): Promise<{ expiredPages: number; expiredEntries: number }> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError('Translation memory retention must be a positive whole number of days');
  }
  const currentPageHash = await pageHash(pageUrl);
  return withMemoryWrite(async () => {
    const stored = await browser.storage.local.get(null);
    const cutoff = Date.now() - retentionDays * DAY_MS;
    const expiredPageHashes = Object.entries(stored)
      .filter(([key, lastVisited]) => key.startsWith(PAGE_PREFIX) && (typeof lastVisited !== 'number' || lastVisited < cutoff))
      .map(([key]) => key.slice(PAGE_PREFIX.length));

    const expiredPrefixes = expiredPageHashes.flatMap((page) => [`${PAGE_PREFIX}${page}`, `${ENTRY_PREFIX}${page}:`]);
    const expiredKeys = Object.keys(stored).filter((key) => expiredPrefixes.some((prefix) => key.startsWith(prefix)));
    if (expiredKeys.length) await browser.storage.local.remove(expiredKeys);

    await browser.storage.local.set({ [`${PAGE_PREFIX}${currentPageHash}`]: Date.now() });
    return {
      expiredPages: expiredPageHashes.length,
      expiredEntries: expiredKeys.filter((key) => key.startsWith(ENTRY_PREFIX)).length,
    };
  });
}

export async function clearPageTranslationMemory(pageUrl: string): Promise<{ removedEntries: number }> {
  const page = await pageHash(pageUrl);
  return withMemoryWrite(async () => {
    const prefixes = [`${PAGE_PREFIX}${page}`, `${ENTRY_PREFIX}${page}:`];
    const stored = await browser.storage.local.get(null);
    const keys = Object.keys(stored).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    if (keys.length) await browser.storage.local.remove(keys);
    return { removedEntries: keys.filter((key) => key.startsWith(ENTRY_PREFIX)).length };
  });
}
