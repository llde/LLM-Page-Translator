import { describe, expect, it } from 'vitest';
import {
  BudgetError,
  buildModelsRequest,
  buildRequest,
  checkBudget,
  estimateTokens,
  extractContent,
  parseModels,
  type LlmConfig,
} from '../src/background/providers';
import type { ChatMessage } from '../src/shared/types';

const base: LlmConfig = {
  provider: 'ollama',
  baseUrl: 'http://h:11434/',
  apiKey: '',
  model: 'llama3',
  contextWindow: 8192,
  maxTokens: 1024,
  temperature: 0.2,
};
const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];

describe('buildRequest', () => {
  it('builds an Ollama request', () => {
    const r = buildRequest(base, msgs);
    expect(r.url).toBe('http://h:11434/api/chat');
    expect(r.body).toEqual({
      model: 'llama3',
      messages: msgs,
      stream: false,
      options: { num_ctx: 8192, num_predict: 1024, temperature: 0.2 },
    });
    expect(r.headers.Authorization).toBeUndefined();
  });

  it('builds an OpenAI-compatible request, respecting a /v1 base', () => {
    const r = buildRequest({ ...base, provider: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: 'k' }, msgs);
    expect(r.url).toBe('https://api.x.com/v1/chat/completions');
    expect(r.headers.Authorization).toBe('Bearer k');
    expect(r.body).toEqual({ model: 'llama3', messages: msgs, stream: false, max_tokens: 1024, temperature: 0.2 });
  });

  it('adds /v1 for OpenAI-compatible when missing', () => {
    expect(buildRequest({ ...base, provider: 'openai', baseUrl: 'http://lm:1234' }, msgs).url).toBe('http://lm:1234/v1/chat/completions');
  });

  it('builds an OpenWebUI request', () => {
    const r = buildRequest({ ...base, provider: 'openwebui', baseUrl: 'http://owui:3000', apiKey: 'sk' }, msgs);
    expect(r.url).toBe('http://owui:3000/api/chat/completions');
    expect(r.headers.Authorization).toBe('Bearer sk');
  });
});

describe('extractContent', () => {
  it('reads Ollama responses', () => {
    expect(extractContent('ollama', { message: { content: 'x' }, done_reason: 'stop' })).toEqual({ content: 'x', truncated: false });
    expect(extractContent('ollama', { message: { content: 'x' }, done_reason: 'length' }).truncated).toBe(true);
  });

  it('reads OpenAI responses', () => {
    expect(extractContent('openai', { choices: [{ message: { content: 'y' }, finish_reason: 'length' }] })).toEqual({
      content: 'y',
      truncated: true,
    });
  });

  it('throws on unexpected shapes', () => {
    expect(() => extractContent('openwebui', { foo: 1 })).toThrow();
  });
});

describe('model listing', () => {
  it('builds list URLs per provider', () => {
    expect(buildModelsRequest(base).url).toBe('http://h:11434/api/tags');
    expect(buildModelsRequest({ ...base, provider: 'openai', baseUrl: 'http://lm:1234' }).url).toBe('http://lm:1234/v1/models');
    expect(buildModelsRequest({ ...base, provider: 'openai', baseUrl: 'https://api.x.com/v1/' }).url).toBe('https://api.x.com/v1/models');
    const owui = buildModelsRequest({ ...base, provider: 'openwebui', baseUrl: 'http://owui:3000', apiKey: 'sk' });
    expect(owui.url).toBe('http://owui:3000/api/models');
    expect(owui.headers.Authorization).toBe('Bearer sk');
  });

  it('parses and sorts model names', () => {
    expect(parseModels('ollama', { models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:latest' }] })).toEqual(['llama3.1:latest', 'qwen3:8b']);
    expect(parseModels('openai', { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] })).toEqual(['gpt-a', 'gpt-b']);
    expect(parseModels('openwebui', { data: [{ id: 'm1' }, { name: 'no-id' }] })).toEqual(['m1']);
  });

  it('returns an empty list on unexpected shapes', () => {
    expect(parseModels('ollama', { foo: 1 })).toEqual([]);
    expect(parseModels('openai', null)).toEqual([]);
  });
});

describe('budget', () => {
  it('estimates ~1 token per 3 chars', () => {
    expect(estimateTokens([{ role: 'user', content: 'a'.repeat(300) }])).toBe(100);
  });

  it('throws when prompt + max tokens exceeds the context window', () => {
    const big: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(3000) }];
    expect(() => checkBudget({ ...base, contextWindow: 1500, maxTokens: 1024 }, big)).toThrow(BudgetError);
    expect(() => checkBudget({ ...base, contextWindow: 4096, maxTokens: 1024 }, big)).not.toThrow();
  });
});
