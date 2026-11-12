import { browser, isFirefox } from '../shared/browser';
import { clearTab, effectiveConfig, hostnameOf, loadGlobal, loadTab, type EffectiveSettings } from '../shared/settings';
import {
  NO_MODEL_LABEL,
  PORT_NAME,
  type ContentConfig,
  type ErrorInfo,
  type GlobalSettings,
  type ModelListResult,
  type PortIn,
  type PortOut,
  type RuntimeRequest,
  type SegmentPayload,
} from '../shared/types';
import { buildMessages, parseResponse, ParseError } from './prompt';
import { BudgetError, buildModelsRequest, buildRequest, checkBudget, extractContent, parseModels, type ModelsConfig } from './providers';
import type { Runtime } from 'webextension-polyfill';

class TranslateError extends Error {
  constructor(public info: ErrorInfo) {
    super(info.message);
  }
}

const MAX_BODY = 8000;
const clip = (s: string) => (s.length > MAX_BODY ? s.slice(0, MAX_BODY) + `\n… (${s.length - MAX_BODY} more chars)` : s);

const CORS_HINT =
  'Hint: check that the backend URL is correct and reachable. Ollama rejects requests from browser extensions ' +
  'unless allowed, e.g. start it with OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*".';

async function getSettings(tabId: number | undefined, url?: string): Promise<EffectiveSettings> {
  const g = await loadGlobal();
  const t = tabId !== undefined ? await loadTab(tabId) : {};
  return effectiveConfig(g, t, url);
}

async function translate(cfg: EffectiveSettings, segments: SegmentPayload[], signal: AbortSignal): Promise<Record<number, string>> {
  const messages = buildMessages(
    { systemPrompt: cfg.systemPrompt, tabPrompt: cfg.tabPrompt, targetLanguage: cfg.targetLanguage, sourceLanguage: cfg.sourceLanguage },
    segments,
  );
  const req = buildRequest(cfg, messages);
  const ctx = `Provider: ${cfg.provider}\nModel: ${cfg.model || NO_MODEL_LABEL}\nURL: ${req.url}`;

  if (!cfg.model) {
    throw new TranslateError({
      message: 'No model selected',
      details: `${ctx}\n\nChoose a model in the extension options (or per tab in the popup), then retry.`,
    });
  }

  try {
    checkBudget(cfg, messages);
  } catch (e) {
    if (e instanceof BudgetError) throw new TranslateError({ message: e.message, details: `${ctx}\n\n${e.details}` });
    throw e;
  }

  if (isFirefox()) {
    // Firefox MV3 treats host permissions as optional: give a precise error if the user has not granted them.
    const granted = await browser.permissions.contains({ origins: [new URL(req.url).origin + '/*'] }).catch(() => true);
    if (!granted) {
      throw new TranslateError({
        message: 'Missing host permission for the backend',
        details: `${ctx}\n\nGrant the extension access to ${new URL(req.url).origin} (or all sites) from the popup, the options page or about:addons.`,
      });
    }
  }

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), cfg.requestTimeoutSec * 1000);
  const onAbort = () => timeoutCtl.abort();
  signal.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: timeoutCtl.signal });
  } catch (e) {
    if (signal.aborted) throw new TranslateError({ message: 'Cancelled', details: ctx });
    if (timeoutCtl.signal.aborted) {
      throw new TranslateError({ message: `Request timed out after ${cfg.requestTimeoutSec}s`, details: ctx });
    }
    throw new TranslateError({ message: 'Network error: backend unreachable', details: `${ctx}\n\n${String(e)}\n\n${CORS_HINT}` });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status} ${res.statusText}`.trim();
    try {
      const j = JSON.parse(text);
      const m = j?.error?.message ?? j?.error ?? j?.detail ?? j?.message;
      if (typeof m === 'string') msg += `: ${m}`;
    } catch {
      /* body is not JSON */
    }
    const hint = res.status === 403 || res.status === 401 ? `\n\n${CORS_HINT}\nAlso verify the API key.` : '';
    throw new TranslateError({ message: msg, status: res.status, details: `${ctx}\nHTTP status: ${res.status}\n\nResponse body:\n${clip(text)}${hint}` });
  }

  let content: string;
  let truncated: boolean;
  try {
    ({ content, truncated } = extractContent(cfg.provider, JSON.parse(text)));
  } catch (e) {
    throw new TranslateError({ message: 'Invalid response from backend', status: res.status, details: `${ctx}\n\n${String(e)}\n\nResponse body:\n${clip(text)}` });
  }

  try {
    return parseResponse(content, segments.map((s) => s.id));
  } catch (e) {
    if (e instanceof ParseError) {
      const t = truncated ? '\n\nThe model stopped because it reached max tokens: increase "Max response tokens".' : '';
      throw new TranslateError({ message: e.message, status: res.status, details: `${ctx}${t}\n\nModel output:\n${clip(e.details)}` });
    }
    throw e;
  }
}

function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof TranslateError) return e.info;
  return { message: e instanceof Error ? e.message : String(e), details: e instanceof Error && e.stack ? e.stack : String(e) };
}

browser.runtime.onConnect.addListener((port: Runtime.Port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  const inflight = new Map<number, AbortController>();
  let connected = true;

  const send = (m: PortOut) => {
    if (connected) port.postMessage(m);
  };

  port.onMessage.addListener(async (raw: unknown) => {
    const msg = raw as PortIn;
    if (msg.type === 'ping') return;
    if (msg.type === 'cancel') {
      inflight.get(msg.chunkId)?.abort();
      inflight.delete(msg.chunkId);
      return;
    }
    if (msg.type === 'translate') {
      const ctl = new AbortController();
      inflight.set(msg.chunkId, ctl);
      let diagnosticsEnabled = false;
      try {
        const cfg = await getSettings(tabId, port.sender?.tab?.url);
        diagnosticsEnabled = cfg.textDiagnostics;
        if (cfg.textDiagnostics) {
          console.info('[LLM Page Translator] backend request received', {
            chunkId: msg.chunkId,
            segmentIds: msg.segments.map((segment) => segment.id),
            segmentCount: msg.segments.length,
          });
        }
        const translations = await translate(cfg, msg.segments, ctl.signal);
        if (!ctl.signal.aborted) {
          if (cfg.textDiagnostics) {
            console.info('[LLM Page Translator] backend translation completed', {
              chunkId: msg.chunkId,
              translationIds: Object.keys(translations),
            });
          }
          send({ type: 'result', chunkId: msg.chunkId, translations });
        }
      } catch (e) {
        if (!ctl.signal.aborted) {
          const error = toErrorInfo(e);
          if (diagnosticsEnabled) {
            console.info('[LLM Page Translator] backend translation failed', { chunkId: msg.chunkId, error: error.message });
          }
          send({ type: 'error', chunkId: msg.chunkId, error });
        }
      } finally {
        inflight.delete(msg.chunkId);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    connected = false;
    for (const c of inflight.values()) c.abort();
    inflight.clear();
  });
});

async function getContentConfig(sender: Runtime.MessageSender): Promise<ContentConfig> {
  const cfg = await getSettings(sender.tab?.id);
  const host = hostnameOf(sender.tab?.url ?? sender.url);
  return {
    maxChunkSize: cfg.maxChunkSize,
    concurrency: Math.max(1, cfg.concurrency),
    translateDynamic: cfg.translateDynamic,
    autoTranslate: !!host && cfg.autoTranslateSites.includes(host),
    textDiagnostics: cfg.textDiagnostics,
  };
}

async function testConnection(settings?: GlobalSettings) {
  const cfg: EffectiveSettings = { ...(settings ?? (await loadGlobal())), tabPrompt: '' } as EffectiveSettings;
  try {
    const r = await translate(cfg, [{ id: 1, text: 'Hello, world! This is a connection test.' }], new AbortController().signal);
    return { ok: true, message: r[1] };
  } catch (e) {
    const info = toErrorInfo(e);
    return { ok: false, message: info.message, details: info.details };
  }
}

browser.runtime.onMessage.addListener((raw: unknown, sender: Runtime.MessageSender) => {
  const msg = raw as RuntimeRequest;
  if (msg?.type === 'getConfig') return getContentConfig(sender);
  if (msg?.type === 'testConnection') return testConnection(msg.settings);
  if (msg?.type === 'listModels') return listModels(msg.backend);
  return undefined;
});

const LIST_MODELS_TIMEOUT_MS = 10_000;

async function listModels(backend?: ModelsConfig): Promise<ModelListResult> {
  const cfg = backend ?? (await loadGlobal());
  if (!cfg.baseUrl?.trim()) return { models: [], error: 'Base URL not set' };
  let req: ReturnType<typeof buildModelsRequest>;
  try {
    req = buildModelsRequest(cfg);
    new URL(req.url);
  } catch {
    return { models: [], error: 'Invalid base URL' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIST_MODELS_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, { headers: req.headers, signal: ctl.signal });
    if (!res.ok) return { models: [], error: `HTTP ${res.status} ${res.statusText} from ${req.url}`.trim() };
    const models = parseModels(cfg.provider, await res.json().catch(() => null));
    return models.length ? { models } : { models, error: `No models returned by ${req.url}` };
  } catch (e) {
    const why = ctl.signal.aborted ? 'timed out' : String(e);
    return { models: [], error: `Backend unreachable (${why}) at ${req.url}` };
  } finally {
    clearTimeout(timer);
  }
}

browser.tabs.onRemoved.addListener((tabId: number) => {
  clearTab(tabId).catch(() => undefined);
});
