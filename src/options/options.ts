import { browser, isFirefox } from '../shared/browser';
import { fillLanguageSelect } from '../shared/languages';
import { fetchModels, fillModelSelect } from '../shared/models';
import { DEFAULT_SETTINGS, loadGlobal, saveGlobal } from '../shared/settings';
import type { GlobalSettings, Provider } from '../shared/types';

const form = document.getElementById('form') as HTMLFormElement;
const msg = document.getElementById('msg') as HTMLSpanElement;
const details = document.getElementById('details') as HTMLPreElement;
const urlHint = document.getElementById('urlHint') as HTMLElement;

const NUMBER_KEYS = ['contextWindow', 'maxTokens', 'temperature', 'requestTimeoutSec', 'maxChunkSize', 'concurrency', 'memoryRetentionDays'] as const;
const TEXT_KEYS = ['provider', 'baseUrl', 'apiKey', 'systemPrompt', 'defaultTabPrompt'] as const;

const URL_HINTS: Record<Provider, string> = {
  ollama: 'e.g. http://localhost:11434 — requests go to {base}/api/chat',
  openwebui: 'e.g. http://localhost:3000 — requests go to {base}/api/chat/completions (API key from OpenWebUI settings)',
  openai: 'e.g. https://api.openai.com/v1 or http://localhost:1234 — requests go to {base}[/v1]/chat/completions',
};

const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const modelSelect = form.elements.namedItem('model') as HTMLSelectElement;
const modelHint = document.getElementById('modelHint') as HTMLElement;

let modelRequest = 0;
let savedTabPromptRules: GlobalSettings['tabPromptRules'] = [];
async function refreshModels() {
  const id = ++modelRequest;
  const current = modelSelect.value || modelSelect.dataset.saved || '';
  modelHint.textContent = 'Loading models…';
  modelHint.className = '';
  const r = await fetchModels({
    provider: input('provider').value as Provider,
    baseUrl: input('baseUrl').value.trim(),
    apiKey: input('apiKey').value.trim(),
  });
  if (id !== modelRequest) return; // a newer refresh superseded this one
  fillModelSelect(modelSelect, r.models, { current });
  modelHint.textContent = r.error ?? `${r.models.length} model(s) available`;
  modelHint.className = r.error ? 'err' : '';
}

let modelTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefreshModels() {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(refreshModels, 500);
}

function fill(s: GlobalSettings) {
  savedTabPromptRules = s.tabPromptRules;
  for (const k of TEXT_KEYS) input(k).value = String(s[k]);
  for (const k of NUMBER_KEYS) input(k).value = String(s[k]);
  input('translateDynamic').checked = s.translateDynamic;
  input('autoTranslateSites').value = s.autoTranslateSites.join('\n');
  modelSelect.dataset.saved = s.model;
  fillModelSelect(modelSelect, [], { current: s.model });
  fillLanguageSelect(form.elements.namedItem('targetLanguage') as HTMLSelectElement, { current: s.targetLanguage });
  updateHint();
  refreshModels();
}

function read(): GlobalSettings {
  const s = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  s.tabPromptRules = savedTabPromptRules;
  for (const k of TEXT_KEYS) s[k] = input(k).value.trim();
  s.model = modelSelect.value;
  s.targetLanguage = input('targetLanguage').value;
  s.systemPrompt = input('systemPrompt').value;
  s.defaultTabPrompt = input('defaultTabPrompt').value;
  for (const k of NUMBER_KEYS) s[k] = Number(input(k).value);
  s.translateDynamic = input('translateDynamic').checked;
  s.autoTranslateSites = input('autoTranslateSites')
    .value.split(/\s+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return s as unknown as GlobalSettings;
}

function validate(s: GlobalSettings): string | null {
  if (!s.model) return 'No model selected: translations will fail until a model is chosen.';
  if (s.maxTokens >= s.contextWindow) return 'Max response tokens must be smaller than the context window.';
  // ~3 chars/token: warn early if a full chunk cannot fit with the response.
  const chunkTokens = Math.ceil((s.maxChunkSize + s.systemPrompt.length + 800) / 3);
  if (chunkTokens + s.maxTokens > s.contextWindow) {
    return `A full chunk (~${chunkTokens} tokens with prompts) plus ${s.maxTokens} response tokens may not fit in the ${s.contextWindow}-token context window.`;
  }
  return null;
}

function show(text: string, ok: boolean, extra?: string) {
  msg.textContent = text;
  msg.className = ok ? 'ok' : 'err';
  details.hidden = !extra;
  details.textContent = extra ?? '';
}

function updateHint() {
  urlHint.textContent = URL_HINTS[input('provider').value as Provider] ?? '';
}

async function checkPermissions() {
  if (!isFirefox()) return;
  const ok = await browser.permissions.contains({ origins: ['<all_urls>'] });
  (document.getElementById('permBanner') as HTMLElement).hidden = ok;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const s = read();
  await saveGlobal(s);
  modelSelect.dataset.saved = s.model;
  const warn = validate(s);
  show(warn ? `Saved — warning: ${warn}` : 'Saved.', !warn);
});

input('provider').addEventListener('change', () => {
  updateHint();
  refreshModels();
});
input('baseUrl').addEventListener('input', scheduleRefreshModels);
input('apiKey').addEventListener('input', scheduleRefreshModels);
document.getElementById('refreshModels')!.addEventListener('click', refreshModels);

document.getElementById('test')!.addEventListener('click', async () => {
  if (!form.reportValidity()) return;
  show('Testing…', true);
  const r = (await browser.runtime.sendMessage({ type: 'testConnection', settings: read() })) as {
    ok: boolean;
    message: string;
    details?: string;
  };
  if (r.ok) show(`OK — model replied: “${r.message}”`, true);
  else show(`Failed: ${r.message}`, false, r.details);
});

document.getElementById('reset')!.addEventListener('click', () => {
  fill({ ...DEFAULT_SETTINGS, autoTranslateSites: read().autoTranslateSites, tabPromptRules: savedTabPromptRules });
  show('Defaults restored in the form — click Save to apply.', true);
});

document.getElementById('grantPerm')!.addEventListener('click', async () => {
  await browser.permissions.request({ origins: ['<all_urls>'] });
  checkPermissions();
});

loadGlobal().then(fill);
checkPermissions();
