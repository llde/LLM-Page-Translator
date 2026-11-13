import { browser, isFirefox } from './browser';
import type { GlobalSettings, TabSettings } from './types';
import { resolveTabPrompt } from './tabPromptRules';

export const DEFAULT_SYSTEM_PROMPT =
  'You are a professional translator. Translate the provided text faithfully and fluently into the target language, ' +
  'preserving meaning, tone, numbers, proper nouns and inline symbols. Do not summarize or explain.';

export const DEFAULT_SETTINGS: GlobalSettings = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: '',
  contextWindow: 8192,
  maxTokens: 2048,
  temperature: 0.2,
  maxChunkSize: 512,
  concurrency: 2,
  requestTimeoutSec: 120,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultTabPrompt: '',
  tabPromptRules: [],
  targetLanguage: 'English',
  autoTranslateSites: [],
  translateDynamic: true,
  separateNumbers: false,
  experimentalSliceGuard: false,
  memoryRetentionDays: 30,
};

const GLOBAL_KEY = 'settings';

/** Former hardcoded default; never a real list entry (Ollama always reports a tag, e.g. "llama3.1:latest"). */
const LEGACY_DEFAULT_MODEL = 'llama3.1';

export function normalizeGlobal(stored: Partial<GlobalSettings> | undefined): GlobalSettings {
  const s = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  if (s.model === LEGACY_DEFAULT_MODEL) s.model = '';
  if (!Number.isInteger(s.memoryRetentionDays) || s.memoryRetentionDays < 1) {
    s.memoryRetentionDays = DEFAULT_SETTINGS.memoryRetentionDays;
  }
  return s;
}

export async function loadGlobal(): Promise<GlobalSettings> {
  const r = await browser.storage.local.get(GLOBAL_KEY);
  return normalizeGlobal(r[GLOBAL_KEY] as Partial<GlobalSettings> | undefined);
}

export async function saveGlobal(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const next = { ...(await loadGlobal()), ...patch };
  await browser.storage.local.set({ [GLOBAL_KEY]: next });
  return next;
}

type StorageArea = typeof browser.storage.local;

/**
 * Per-tab settings live in storage.session (cleared when the browser closes).
 * Fallback to storage.local for browsers lacking storage.session; the background
 * script removes those entries on tabs.onRemoved.
 */
function tabArea(): StorageArea {
  const session = (browser.storage as unknown as { session?: StorageArea }).session;
  if (session) return session;
  if (isFirefox()) console.warn('storage.session unavailable, falling back to storage.local');
  return browser.storage.local;
}

const tabKey = (tabId: number) => `tab:${tabId}`;

export async function loadTab(tabId: number): Promise<TabSettings> {
  const r = await tabArea().get(tabKey(tabId));
  return (r[tabKey(tabId)] as TabSettings) ?? {};
}

export async function saveTab(tabId: number, s: TabSettings): Promise<void> {
  await tabArea().set({ [tabKey(tabId)]: s });
}

export async function clearTab(tabId: number): Promise<void> {
  await tabArea().remove(tabKey(tabId));
}

export interface EffectiveSettings extends GlobalSettings {
  tabPrompt: string;
  textDiagnostics: boolean;
  /** Empty = auto-detect. */
  sourceLanguage: string;
}

const isSet = <T>(v: T | undefined | null | ''): v is T => v !== undefined && v !== null && v !== '';

export function effectiveConfig(g: GlobalSettings, t: TabSettings, url?: string): EffectiveSettings {
  return {
    ...g,
    tabPrompt: resolveTabPrompt(t.tabPrompt, g.defaultTabPrompt, url, g.tabPromptRules),
    textDiagnostics: t.textDiagnostics ?? false,
    sourceLanguage: t.sourceLanguage ?? '',
    targetLanguage: isSet(t.targetLanguage) ? t.targetLanguage : g.targetLanguage,
    maxChunkSize: isSet(t.maxChunkSize) && t.maxChunkSize > 0 ? t.maxChunkSize : g.maxChunkSize,
    model: isSet(t.model) ? t.model : g.model,
    temperature: isSet(t.temperature) ? t.temperature : g.temperature,
  };
}

export function hostnameOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}
