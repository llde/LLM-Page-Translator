import type { ChatMessage, Provider } from '../shared/types';

export interface LlmConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export class BudgetError extends Error {
  constructor(message: string, public details: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

const trimSlash = (u: string) => u.trim().replace(/\/+$/, '');

/** OpenAI-compatible API root: keeps an explicit /vN suffix, otherwise appends /v1. */
const openAiRoot = (base: string) => (/\/v\d+$/.test(base) ? base : `${base}/v1`);

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function buildRequest(cfg: LlmConfig, messages: ChatMessage[]): BuiltRequest {
  const base = trimSlash(cfg.baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders(cfg.apiKey) };

  if (cfg.provider === 'ollama') {
    return {
      url: `${base}/api/chat`,
      headers,
      body: {
        model: cfg.model,
        messages,
        stream: false,
        options: { num_ctx: cfg.contextWindow, num_predict: cfg.maxTokens, temperature: cfg.temperature },
      },
    };
  }

  const url = cfg.provider === 'openwebui' ? `${base}/api/chat/completions` : `${openAiRoot(base)}/chat/completions`;
  return {
    url,
    headers,
    body: { model: cfg.model, messages, stream: false, max_tokens: cfg.maxTokens, temperature: cfg.temperature },
  };
}

export type ModelsConfig = Pick<LlmConfig, 'provider' | 'baseUrl' | 'apiKey'>;

export function buildModelsRequest(cfg: ModelsConfig): { url: string; headers: Record<string, string> } {
  const base = trimSlash(cfg.baseUrl);
  const url =
    cfg.provider === 'ollama' ? `${base}/api/tags` : cfg.provider === 'openwebui' ? `${base}/api/models` : `${openAiRoot(base)}/models`;
  return { url, headers: authHeaders(cfg.apiKey) };
}

/** Extract a sorted, de-duplicated list of model names; unknown shapes yield an empty list. */
export function parseModels(provider: Provider, json: any): string[] {
  const items: unknown[] = provider === 'ollama' ? json?.models : json?.data;
  if (!Array.isArray(items)) return [];
  const names = items
    .map((m: any) => (provider === 'ollama' ? (m?.name ?? m?.model) : m?.id))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function extractContent(provider: Provider, json: any): { content: string; truncated: boolean } {
  if (provider === 'ollama') {
    const content = json?.message?.content;
    if (typeof content !== 'string') throw new Error('Unexpected Ollama response shape (missing message.content)');
    return { content, truncated: json?.done_reason === 'length' };
  }
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') throw new Error('Unexpected response shape (missing choices[0].message.content)');
  return { content, truncated: choice?.finish_reason === 'length' };
}

/** Rough, model-agnostic token estimate (~3 characters per token, conservative for non-English). */
export function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 3);
}

export function checkBudget(cfg: LlmConfig, messages: ChatMessage[]): void {
  const prompt = estimateTokens(messages);
  if (prompt + cfg.maxTokens > cfg.contextWindow) {
    throw new BudgetError(
      'Context window exceeded',
      `Estimated prompt tokens (${prompt}) + max response tokens (${cfg.maxTokens}) = ${prompt + cfg.maxTokens} ` +
        `> context window (${cfg.contextWindow}). Reduce the chunk size or max tokens, or increase the context window.`,
    );
  }
}
