import { browser, isFirefox } from '../shared/browser';
import { AUTO_DETECT_LABEL, fillLanguageSelect } from '../shared/languages';
import { fetchModels, fillModelSelect } from '../shared/models';
import { hostnameOf, loadGlobal, loadTab, saveGlobal, saveTab } from '../shared/settings';
import { findTabPromptRule, makeTabPromptRule, tabPromptRulePrefixes } from '../shared/tabPromptRules';
import { NO_MODEL_LABEL, type GlobalSettings, type PageStatus, type TabRequest, type TabSettings } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $<HTMLDivElement>('status');
const fields = {
  sourceLanguage: $<HTMLSelectElement>('sourceLanguage'),
  targetLanguage: $<HTMLSelectElement>('targetLanguage'),
  tabPrompt: $<HTMLTextAreaElement>('tabPrompt'),
  maxChunkSize: $<HTMLInputElement>('maxChunkSize'),
  model: $<HTMLSelectElement>('model'),
  temperature: $<HTMLInputElement>('temperature'),
  textDiagnostics: $<HTMLInputElement>('textDiagnostics'),
  separateNumbers: $<HTMLSelectElement>('separateNumbers'),
  enableSetterHooks: $<HTMLSelectElement>('enableSetterHooks'),
  experimentalSliceGuard: $<HTMLSelectElement>('experimentalSliceGuard'),
  experimentalCachedTextContent: $<HTMLSelectElement>('experimentalCachedTextContent'),
};

let tabId = -1;
let host = '';
let tabUrl = '';
let global: GlobalSettings;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', error);
}

function renderStatus(s: PageStatus) {
  $('retry').hidden = s.errors === 0;
  if (!s.active) return setStatus('Not translated.');
  const parts = [`${s.done}/${s.total} chunks done`];
  if (s.busy) parts.push(`${s.busy} in progress`);
  if (s.queued) parts.push(`${s.queued} queued`);
  if (s.errors) parts.push(`${s.errors} failed`);
  if (s.oversized) parts.push(`${s.oversized} too long (choose in page)`);
  setStatus(parts.join(' · '), s.errors > 0);
}

async function sendToTab(msg: TabRequest): Promise<PageStatus | null> {
  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    const responses = await Promise.allSettled(
      (frames ?? []).map(({ frameId }) => browser.tabs.sendMessage(tabId, msg, { frameId }) as Promise<PageStatus>),
    );
    const statuses = responses.flatMap((response) => response.status === 'fulfilled' ? [response.value] : []);
    if (!statuses.length) throw new Error('No injectable frame responded');
    return {
      active: statuses.some((status) => status.active),
      total: statuses.reduce((total, status) => total + status.total, 0),
      done: statuses.reduce((total, status) => total + status.done, 0),
      busy: statuses.reduce((total, status) => total + status.busy, 0),
      queued: statuses.reduce((total, status) => total + status.queued, 0),
      errors: statuses.reduce((total, status) => total + status.errors, 0),
      oversized: statuses.reduce((total, status) => total + status.oversized, 0),
    };
  } catch (e) {
    setStatus(`This page cannot be translated: ${String(e)} (restricted page, or reload the tab after installing the extension).`, true);
    return null;
  }
}

async function refresh() {
  const s = await sendToTab({ type: 'status' });
  if (s) renderStatus(s);
}

function readTabSettings(): TabSettings {
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const bool = (v: string) => v === 'true' ? true : v === 'false' ? false : undefined;
  return {
    sourceLanguage: fields.sourceLanguage.value || undefined,
    targetLanguage: fields.targetLanguage.value || undefined,
    tabPrompt: fields.tabPrompt.value,
    maxChunkSize: num(fields.maxChunkSize.value),
    model: fields.model.value.trim() || undefined,
    temperature: num(fields.temperature.value),
    textDiagnostics: fields.textDiagnostics.checked,
    separateNumbers: bool(fields.separateNumbers.value),
    enableSetterHooks: bool(fields.enableSetterHooks.value),
    experimentalSliceGuard: bool(fields.experimentalSliceGuard.value),
    experimentalCachedTextContent: bool(fields.experimentalCachedTextContent.value),
  };
}

let availableModels: string[] = [];

function fillModel(current: string) {
  fillModelSelect(fields.model, availableModels, {
    current,
    leadingLabel: `(global: ${global.model || NO_MODEL_LABEL})`,
  });
}

function fillTabSettings(t: TabSettings) {
  fillLanguageSelect(fields.sourceLanguage, { current: t.sourceLanguage ?? '', leadingLabel: AUTO_DETECT_LABEL });
  fillLanguageSelect(fields.targetLanguage, { current: t.targetLanguage ?? '', leadingLabel: `(global: ${global.targetLanguage})` });
  fields.tabPrompt.value = effectivePrompt(t);
  updatePromptRuleStatus(t);
  fields.maxChunkSize.value = t.maxChunkSize?.toString() ?? '';
  fillModel(t.model ?? '');
  fields.temperature.value = t.temperature?.toString() ?? '';
  fields.textDiagnostics.checked = t.textDiagnostics ?? false;
  for (const key of ['separateNumbers', 'enableSetterHooks', 'experimentalSliceGuard', 'experimentalCachedTextContent'] as const) {
    fields[key].options[0].textContent = `Global default (${global[key] ? 'enabled' : 'disabled'})`;
    fields[key].value = t[key] === undefined ? '' : String(t[key]);
  }
  updateHookOptions();
}

function updateHookOptions() {
  const enabled = fields.enableSetterHooks.value === '' ? global.enableSetterHooks : fields.enableSetterHooks.value === 'true';
  fields.experimentalSliceGuard.disabled = !enabled;
  fields.experimentalCachedTextContent.disabled = !enabled;
}

function effectivePrompt(t: TabSettings): string {
  const rule = tabUrl ? findTabPromptRule(tabUrl, global.tabPromptRules) : undefined;
  return t.tabPrompt?.trim() ? t.tabPrompt : rule?.prompt.trim() ? rule.prompt : global.defaultTabPrompt;
}

function updatePromptRuleStatus(t: TabSettings) {
  const status = $<HTMLDivElement>('promptRuleStatus');
  const rule = tabUrl ? findTabPromptRule(tabUrl, global.tabPromptRules) : undefined;
  status.classList.remove('err');
  if (rule && t.tabPrompt?.trim()) {
    status.textContent = `This tab's prompt overrides the saved rule for ${rule.urlPrefix}`;
  } else if (rule) {
    status.textContent = `Using saved prompt rule: ${rule.urlPrefix}`;
  } else {
    status.textContent = 'Save this prompt to reuse it on this path and its subpages.';
  }
}

async function loadModels() {
  availableModels = (await fetchModels()).models;
  // Re-read the current selection so a choice made while the list was loading is kept.
  fillModel(fields.model.value);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveTab(tabId, readTabSettings()), 250);
}

async function checkPermissions() {
  // Firefox MV3 host permissions are opt-in: offer to grant them from the popup.
  if (!isFirefox()) return;
  const ok = await browser.permissions.contains({ origins: ['<all_urls>'] });
  $('permBanner').hidden = ok;
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  tabUrl = tab?.url ?? '';
  host = hostnameOf(tab?.url);
  global = await loadGlobal();

  fields.maxChunkSize.placeholder = String(global.maxChunkSize);
  fields.temperature.placeholder = String(global.temperature);
  fillTabSettings(await loadTab(tabId));
  loadModels();

  $('host').textContent = host || 'this site';
  const savePromptRule = $<HTMLButtonElement>('savePromptRule');
  const promptRulePath = $<HTMLSelectElement>('promptRulePath');
  const promptRuleStatus = $<HTMLDivElement>('promptRuleStatus');
  if (/^https?:\/\//i.test(tabUrl)) {
    for (const prefix of tabPromptRulePrefixes(tabUrl)) {
      const option = document.createElement('option');
      option.value = prefix;
      option.textContent = prefix;
      promptRulePath.append(option);
    }
    promptRulePath.disabled = false;
  }
  const updateSavePromptRuleState = () => {
    savePromptRule.disabled = promptRulePath.disabled || !fields.tabPrompt.value.trim();
  };
  updateSavePromptRuleState();
  const auto = $<HTMLInputElement>('autoSite');
  auto.checked = !!host && global.autoTranslateSites.includes(host);
  auto.disabled = !host;
  auto.addEventListener('change', async () => {
    const sites = new Set(global.autoTranslateSites);
    if (auto.checked) sites.add(host);
    else sites.delete(host);
    global = await saveGlobal({ autoTranslateSites: [...sites] });
  });

  Object.values(fields).forEach((f) => f.addEventListener('input', scheduleSave));
  fields.enableSetterHooks.addEventListener('change', updateHookOptions);
  fields.textDiagnostics.addEventListener('change', async () => {
    clearTimeout(saveTimer);
    try {
      await saveTab(tabId, readTabSettings());
    } catch (e) {
      setStatus(`Could not save text diagnostics setting: ${String(e)}`, true);
      return;
    }
    try {
      await browser.tabs.sendMessage(tabId, { type: 'setDiagnostics', enabled: fields.textDiagnostics.checked });
    } catch (e) {
      setStatus(`Saved the setting, but could not apply diagnostics to this page: ${String(e)}`, true);
    }
  });
  fields.tabPrompt.addEventListener('input', () => {
    updatePromptRuleStatus(readTabSettings());
    updateSavePromptRuleState();
  });
  savePromptRule.addEventListener('click', async () => {
    savePromptRule.disabled = true;
    try {
      clearTimeout(saveTimer);
      const rule = makeTabPromptRule(promptRulePath.value, fields.tabPrompt.value);
      const rules = global.tabPromptRules.filter((existing) => existing.urlPrefix !== rule.urlPrefix);
      global = await saveGlobal({ tabPromptRules: [...rules, rule] });
      const tabSettings = readTabSettings();
      delete tabSettings.tabPrompt;
      try {
        await saveTab(tabId, tabSettings);
      } catch (e) {
        promptRuleStatus.textContent = `Saved the rule, but could not clear this tab's override: ${String(e)}`;
        promptRuleStatus.classList.add('err');
        return;
      }
      fillTabSettings(tabSettings);
      promptRuleStatus.textContent = `Saved prompt rule for ${rule.urlPrefix}`;
    } catch (e) {
      promptRuleStatus.textContent = `Could not save prompt rule: ${String(e)}`;
      promptRuleStatus.classList.add('err');
    } finally {
      updateSavePromptRuleState();
    }
  });

  $('translate').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await saveTab(tabId, readTabSettings());
    setStatus('Starting…');
    const s = await sendToTab({ type: 'start' });
    if (s) renderStatus(s);
  });
  $('restore').addEventListener('click', async () => {
    const s = await sendToTab({ type: 'restore' });
    if (s) renderStatus(s);
  });
  $('retry').addEventListener('click', async () => {
    const s = await sendToTab({ type: 'retryErrors' });
    if (s) renderStatus(s);
  });
  $('clearMemory').addEventListener('click', async () => {
    if (tabId < 0 || !tabUrl) {
      setStatus('Could not clear page memory: active tab is unavailable.', true);
      return;
    }
    try {
      await browser.runtime.sendMessage({ type: 'clearPageMemory', pageUrl: tabUrl, tabId });
      setStatus('Memory cleared for this page.');
    } catch (e) {
      setStatus(`Could not clear page memory: ${String(e)}`, true);
    }
  });
  $('resetTab').addEventListener('click', async () => {
    const keep: TabSettings = {
      tabPrompt: fields.tabPrompt.value,
      sourceLanguage: fields.sourceLanguage.value || undefined,
      targetLanguage: fields.targetLanguage.value || undefined,
    };
    await saveTab(tabId, keep);
    fillTabSettings(keep);
  });
  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });
  $('grantPerm').addEventListener('click', async () => {
    await browser.permissions.request({ origins: ['<all_urls>'] });
    checkPermissions();
  });

  await checkPermissions();
  await refresh();
  pollTimer = setInterval(refresh, 1000);
}

window.addEventListener('unload', () => clearInterval(pollTimer));
init().catch((e) => setStatus(String(e), true));
