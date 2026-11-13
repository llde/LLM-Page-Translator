export type Provider = 'ollama' | 'openai' | 'openwebui';

export interface GlobalSettings {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  maxChunkSize: number;
  concurrency: number;
  requestTimeoutSec: number;
  systemPrompt: string;
  defaultTabPrompt: string;
  tabPromptRules: TabPromptRule[];
  targetLanguage: string;
  autoTranslateSites: string[];
  translateDynamic: boolean;
  experimentalSliceGuard: boolean;
  memoryRetentionDays: number;
}

export interface TabPromptRule {
  urlPrefix: string;
  prompt: string;
}

/** Per-tab overrides; undefined/empty fields fall back to global settings. */
export interface TabSettings {
  tabPrompt?: string;
  textDiagnostics?: boolean;
  /** Empty/undefined = auto-detect. */
  sourceLanguage?: string;
  targetLanguage?: string;
  maxChunkSize?: number;
  model?: string;
  temperature?: number;
}

export interface SegmentPayload {
  id: number;
  text: string;
  /** Source text DOM depth, used only by the content-script chunker. */
  domLevel?: number;
}

export interface ErrorInfo {
  message: string;
  status?: number;
  details: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Content script -> background (over the "xt" port). */
export type PortIn =
  | { type: 'checkMemory'; chunkId: number; segments: SegmentPayload[] }
  | { type: 'translate'; chunkId: number; segments: SegmentPayload[] }
  | { type: 'cancel'; chunkId: number }
  | { type: 'ping' };

/** Background -> content script (over the "xt" port). */
export type PortOut =
  | { type: 'memoryHit'; chunkId: number; translations: Record<number, string> }
  | { type: 'memoryMiss'; chunkId: number }
  | { type: 'result'; chunkId: number; translations: Record<number, string> }
  | { type: 'error'; chunkId: number; error: ErrorInfo };

export interface ContentConfig {
  maxChunkSize: number;
  concurrency: number;
  translateDynamic: boolean;
  experimentalSliceGuard: boolean;
  autoTranslate: boolean;
  textDiagnostics: boolean;
}

export interface PageStatus {
  active: boolean;
  total: number;
  done: number;
  busy: number;
  queued: number;
  errors: number;
  oversized: number;
}

/** Messages handled by background via runtime.sendMessage. */
export type RuntimeRequest =
  | { type: 'getConfig' }
  | { type: 'installSetterGuard' }
  | { type: 'testConnection'; settings?: GlobalSettings }
  | { type: 'clearPageMemory'; pageUrl: string; tabId: number }
  | { type: 'listModels'; backend?: Pick<GlobalSettings, 'provider' | 'baseUrl' | 'apiKey'> };

export interface ModelListResult {
  models: string[];
  /** Set when the backend is unreachable or answered with an error. */
  error?: string;
}

export const NO_MODEL_LABEL = '<no model>';

/** Messages handled by content script via tabs.sendMessage. */
export type TabRequest =
  | { type: 'start' }
  | { type: 'restore' }
  | { type: 'status' }
  | { type: 'retryErrors' }
  | { type: 'setDiagnostics'; enabled: boolean };

export const PORT_NAME = 'xt';
