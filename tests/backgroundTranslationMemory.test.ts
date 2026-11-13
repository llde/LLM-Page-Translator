import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  onConnectListener: undefined as ((port: unknown) => void) | undefined,
  onMessageListener: undefined as ((message: unknown, sender: unknown) => unknown) | undefined,
  onPortMessageListener: undefined as ((message: unknown) => Promise<void>) | undefined,
  config: {
    provider: 'ollama',
    model: 'mock',
    textDiagnostics: false,
    requestTimeoutSec: 1,
    concurrency: 1,
  },
  getTranslationMemory: vi.fn(),
  browser: {
    runtime: {
      getURL: () => 'chrome-extension://test/',
      onConnect: {
        addListener(listener: (port: unknown) => void) {
          harness.onConnectListener = listener;
        },
      },
      onMessage: {
        addListener(listener: (message: unknown, sender: unknown) => unknown) {
          harness.onMessageListener = listener;
        },
      },
    },
    webNavigation: {
      getAllFrames: vi.fn(),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
    },
  },
}));

vi.mock('webextension-polyfill', () => ({ default: harness.browser }));
vi.mock('../src/shared/settings', () => ({
  clearTab: vi.fn(),
  effectiveConfig: () => harness.config,
  hostnameOf: vi.fn(),
  loadGlobal: vi.fn(async () => ({})),
  loadTab: vi.fn(async () => ({})),
}));
vi.mock('../src/shared/translationMemory', () => ({
  clearPageTranslationMemory: vi.fn(),
  getTranslationMemory: harness.getTranslationMemory,
  setTranslationMemory: vi.fn(),
  visitTranslationMemory: vi.fn(async () => ({ expiredPages: 0, expiredEntries: 0 })),
}));
vi.mock('../src/background/prompt', () => ({
  buildMessages: vi.fn(() => []),
  parseResponse: vi.fn(() => ({ 7: 'Ciao.' })),
  ParseError: class ParseError extends Error {},
}));
vi.mock('../src/background/providers', () => ({
  BudgetError: class BudgetError extends Error {},
  buildModelsRequest: vi.fn(),
  buildRequest: vi.fn(() => ({ url: 'https://backend.example/api', headers: {}, body: {} })),
  checkBudget: vi.fn(),
  extractContent: vi.fn(() => ({ content: 'translated', truncated: false })),
  parseModels: vi.fn(() => []),
}));

import type { Runtime } from 'webextension-polyfill';
import { PORT_NAME } from '../src/shared/types';
import '../src/background/index';

describe('background translation memory context', () => {
  beforeEach(() => {
    harness.onPortMessageListener = undefined;
    harness.browser.webNavigation.getAllFrames.mockRejectedValue(new Error('frame metadata unavailable'));
    harness.getTranslationMemory.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{}',
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns a memory hit without entering the provider path', async () => {
    const port = connectPort();
    harness.browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/article' },
      { frameId: 5, parentFrameId: 0, url: 'https://example.com/frame' },
    ]);
    harness.getTranslationMemory.mockResolvedValue({ 7: 'Ciao.' });

    await sendPortMessage({
      type: 'checkMemory',
      chunkId: 2,
      segments: [{ id: 7, text: 'Hello.' }],
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'memoryHit',
      chunkId: 2,
      translations: { 7: 'Ciao.' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a memory miss when frame ancestry is unavailable', async () => {
    const port = connectPort();

    await sendPortMessage({
      type: 'checkMemory',
      chunkId: 3,
      segments: [{ id: 7, text: 'Hello.' }],
    });

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'memoryMiss', chunkId: 3 });
    expect(harness.getTranslationMemory).not.toHaveBeenCalled();
  });

  it('surfaces translation-memory storage failures instead of treating them as misses', async () => {
    const port = connectPort();
    harness.browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/article' },
      { frameId: 5, parentFrameId: 0, url: 'https://example.com/frame' },
    ]);
    harness.getTranslationMemory.mockRejectedValue(new Error('storage unavailable'));

    await sendPortMessage({
      type: 'checkMemory',
      chunkId: 4,
      segments: [{ id: 7, text: 'Hello.' }],
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'error',
      chunkId: 4,
      error: expect.objectContaining({ message: 'storage unavailable' }),
    });
  });

  it('translates without caching when frame ancestry lookup fails', async () => {
    const port = connectPort();
    await sendPortMessage({
      type: 'translate',
      chunkId: 1,
      segments: [{ id: 7, text: 'Hello.' }],
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'result',
      chunkId: 1,
      translations: { 7: 'Ciao.' },
    });
  });
});

function connectPort() {
  const port = {
    name: PORT_NAME,
    sender: { tab: { id: 12, url: 'https://example.com/article' }, frameId: 5 },
    onMessage: {
      addListener(listener: (message: unknown) => Promise<void>) {
        harness.onPortMessageListener = listener;
      },
    },
    onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn(),
  };
  harness.onConnectListener?.(port as unknown as Runtime.Port);
  return port;
}

async function sendPortMessage(message: unknown): Promise<void> {
  await harness.onPortMessageListener?.(message);
}
