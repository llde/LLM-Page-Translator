import type { Runtime } from 'webextension-polyfill';
import { browser } from '../shared/browser';
import { buildChunks } from '../shared/chunker';
import { splitNumberSeparatedPhrases, splitOversized, splitPhrases } from '../shared/phrases';
import { isStoredTranslation, type TranslationMemoryIndex } from '../shared/translationMemory';
import {
  PORT_NAME,
  type ContentConfig,
  type ErrorInfo,
  type PageStatus,
  type PortIn,
  type PortOut,
  type SegmentPayload,
  type TabRequest,
} from '../shared/types';
import { createBadge } from './badge';
import { analyzeMutationBatch, diagnosticMutation, diagnosticTextPreview, logTextDiagnostic } from './diagnostics';
import { canTranslateTextAssignment, createSegSpan, createWrappedText, isOwnNode, matchesOriginalInnerHTML, originalTextContent, preserveTranslatedInnerHTML, restoreAll, scanFormInputs, scanTextNodes, splitWhitespace, wrapTextNode, type WrappedSegment } from './dom';
import { injectStyles, removeStyles } from './styles';

type ChunkState = 'checking' | 'queued' | 'busy' | 'done' | 'error' | 'oversized';

interface Seg {
  id: number;
  element: HTMLElement;
  raw: string;
  domLevel: number;
  inputGroup?: InputGroup;
  translation?: string;
}

interface InputGroup {
  input: HTMLInputElement;
  original: string;
  rendered: string;
  segments: Seg[];
}

interface Chunk {
  id: number;
  segIds: number[];
  size: number;
  state: ChunkState;
  badge?: HTMLElement;
}

const KEEPALIVE_MS = 20_000;
const MUTATION_DEBOUNCE_MS = 600;
const STATE_CLASSES = ['xt-busy', 'xt-spin', 'xt-error', 'xt-oversized'];

let active = false;
let cfg: ContentConfig | null = null;
const segs = new Map<number, Seg>();
const inputGroups = new Set<InputGroup>();
let scannedInputs = new WeakSet<HTMLInputElement>();
const chunks = new Map<number, Chunk>();
let queue: number[] = [];
let busy = 0;
let nextSegId = 1;
let nextChunkId = 1;
let port: Runtime.Port | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let setterGuardInstalled = false;
let ignoredSliceText = new WeakMap<Text, string>();
let memoryIndex: TranslationMemoryIndex | null = null;
let cachedChunks = new Map<string, string[]>();
let pendingIndex: { changes: { key: string; value: unknown }[]; invalidated: boolean } | null = null;

function rebuildCachedChunks(): void {
  cachedChunks = new Map(Object.values(memoryIndex?.entries ?? {}).map(({ texts, translations }) =>
    [JSON.stringify(texts), translations]));
}

function applyIndexChange(index: TranslationMemoryIndex, key: string, value: unknown): void {
  if (!key.startsWith(index.prefix)) return;
  if (isStoredTranslation(value) && value.scope === index.scope) {
    index.entries[key] = { texts: value.texts, translations: value.translations };
  } else {
    delete index.entries[key];
  }
}

function invalidateMemoryIndex(): void {
  memoryIndex = null;
  cachedChunks.clear();
  if (pendingIndex) pendingIndex.invalidated = true;
  if (active && cfg?.translateDynamic && cfg.experimentalCachedTextContent) {
    const pending = { changes: [] as { key: string; value: unknown }[], invalidated: false };
    pendingIndex = pending;
    void loadMemoryIndex(pending);
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  let updated = false;
  for (const [key, change] of Object.entries(changes)) {
    if ((area === 'local' && key === 'settings') || ((area === 'local' || area === 'session') && key.startsWith('tab:'))) {
      if (area === 'local' && key === 'settings' && cfg) {
        const settings = change.newValue;
        cfg = {
          ...cfg,
          experimentalCachedTextContent: cfg.enableSetterHooks && (cfg.experimentalCachedTextContentOverride ??
            (!!settings && typeof settings === 'object' &&
              'experimentalCachedTextContent' in settings && settings.experimentalCachedTextContent === true)),
        };
      }
      invalidateMemoryIndex();
    } else if (area === 'local') {
      if (pendingIndex) pendingIndex.changes.push({ key, value: change.newValue });
      if (memoryIndex && key.startsWith(memoryIndex.prefix)) {
        applyIndexChange(memoryIndex, key, change.newValue);
        updated = true;
      }
    }
  }
  if (updated && memoryIndex) rebuildCachedChunks();
});

async function loadMemoryIndex(pending: NonNullable<typeof pendingIndex>): Promise<void> {
  try {
    const index = await browser.runtime.sendMessage({ type: 'getTranslationMemoryIndex' }) as TranslationMemoryIndex;
    if (pendingIndex !== pending || pending.invalidated) return;
    for (const { key, value } of pending.changes) applyIndexChange(index, key, value);
    memoryIndex = index;
    rebuildCachedChunks();
  } catch (error) {
    console.warn('[LLM Page Translator] Could not load the synchronous translation memory index', error);
  } finally {
    if (pendingIndex === pending) pendingIndex = null;
  }
}

function applyCachedText(target: Node, value: string): boolean {
  const config = cfg;
  if (!config?.translateDynamic || !config.experimentalCachedTextContent || !memoryIndex || !canTranslateTextAssignment(target, value)) return false;
  const parts = config.separateNumbers
    ? splitNumberSeparatedPhrases(value)
    : splitPhrases(value).map((raw) => ({ raw, kind: 'text' as const }));
  const planned: { ids: number[]; size: number; translations: string[] }[] = [];
  let batch: SegmentPayload[] = [];
  let nextId = 0;
  const planBatch = (): boolean => {
    const batchPlans = buildChunks(batch, config.maxChunkSize);
    const textsById = new Map(batch.map(({ id, text }) => [id, text]));
    for (const plan of batchPlans) {
      if (plan.oversized) return false;
      const texts = plan.segmentIds.map((id) => textsById.get(id)!);
      const translations = cachedChunks.get(JSON.stringify(texts));
      if (!translations || translations.length !== texts.length) return false;
      planned.push({ ids: plan.segmentIds, size: plan.size, translations });
    }
    batch = [];
    return true;
  };
  for (const part of parts) {
    if (part.kind === 'number') {
      if (!planBatch()) return false;
    } else if (part.kind === 'text') {
      batch.push({ id: nextId++, text: part.raw });
    }
  }
  if (!planBatch() || !planned.length) return false;
  const parent = target.nodeType === Node.ELEMENT_NODE ? target as Element : target.parentElement;
  if (!parent) return false;
  let domLevel = 0;
  for (let element: Element | null = parent; element && element !== document.body; element = element.parentElement) domLevel++;
  const textTarget = target instanceof Text ? target : undefined;
  const wrapped = createWrappedText(value, () => nextSegId++, config.separateNumbers, !!textTarget);
  const segments = wrapped.segments.filter((segment): segment is WrappedSegment => !('separator' in segment));
  let appliedPlans = planned;
  if (textTarget) {
    const translations = new Map<number, string>();
    for (const plan of planned) plan.ids.forEach((id, i) => translations.set(id, plan.translations[i]));
    let id = 0;
    const rendered = parts.map((part) => {
      if (part.kind !== 'text') return part.raw;
      const { lead, trail } = splitWhitespace(part.raw);
      return lead + translations.get(id++)! + trail;
    }).join('');
    const { lead, trail } = splitWhitespace(value);
    appliedPlans = [{
      ids: [0],
      size: planned.reduce((size, plan) => size + plan.size, 0),
      translations: [rendered.slice(lead.length, rendered.length - trail.length)],
    }];
  }
  const segmentIds: number[] = [];
  for (const plan of appliedPlans) {
    const ids: number[] = [];
    plan.ids.forEach((id, i) => {
      const segment = segments[id];
      const translation = plan.translations[i];
      const { lead, core, trail } = splitWhitespace(segment.raw);
      segment.span.textContent = lead + translation + trail;
      segment.span.title = core;
      segs.set(segment.id, { id: segment.id, element: segment.span, raw: segment.raw, domLevel, translation });
      ids.push(segment.id);
      segmentIds.push(segment.id);
    });
    const chunk: Chunk = { id: nextChunkId++, segIds: ids, size: plan.size, state: 'done' };
    chunks.set(chunk.id, chunk);
  }
  if (observer) processMutationRecords(observer.takeRecords());
  const mutationTarget = target.nodeType === Node.ELEMENT_NODE ? target : target.parentNode;
  if (target instanceof Element) target.replaceChildren(wrapped.container);
  else {
    target.parentNode!.replaceChild(wrapped.container, target);
    const span = segments[0].span;
    const rendered = span.textContent ?? '';
    span.replaceChildren(target);
    if (textTarget) textTarget.data = rendered;
  }
  if (observer) {
    const records = observer.takeRecords();
    const ownRecord = records.find((record) => record.target === mutationTarget &&
      Array.from(record.addedNodes).includes(wrapped.container));
    processMutationRecords(records.filter((record) => record !== ownRecord));
  }
  if (config.textDiagnostics) logTextDiagnostic('setter translation memory hit', { segmentIds });
  return true;
}

function setterMatches(target: Node, type: string, value: string): boolean {
  if (type === 'llm-page-translator:check-text-content' || type === 'llm-page-translator:detached-text') {
    return originalTextContent(target) === value || applyCachedText(target, value);
  }
  return target instanceof Element && (matchesOriginalInnerHTML(target, value) ||
    preserveTranslatedInnerHTML(target, value, (element) => {
      const seg = segs.get(Number(element.dataset.xtId));
      return seg?.element === element ? seg : undefined;
    }));
}

function checkSetter(event: Event): void {
  if (!active || !(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (setterMatches(target, event.type, event.detail)) event.preventDefault();
}

document.addEventListener('llm-page-translator:check-text-content', checkSetter, true);
document.addEventListener('llm-page-translator:check-inner-html', checkSetter, true);

const detachedSetterChecks = new Map<number, { type: string; value: string }>();
function rememberDetachedSetter(event: Event): void {
  if (!active || !(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
  const separator = event.detail.indexOf(':');
  if (separator < 1) return;
  const id = Number(event.detail.slice(0, separator));
  if (!Number.isInteger(id) || id < 1) return;
  detachedSetterChecks.set(id, { type: event.type, value: event.detail.slice(separator + 1) });
}
document.addEventListener('llm-page-translator:detached-text', rememberDetachedSetter, true);
document.addEventListener('llm-page-translator:detached-html', rememberDetachedSetter, true);
document.addEventListener('llm-page-translator:detached-target', (event) => {
  if (!active || !(event instanceof FocusEvent)) return;
  const check = detachedSetterChecks.get(event.detail);
  const target = event.relatedTarget;
  if (check && target instanceof Node && setterMatches(target, check.type, check.value)) event.preventDefault();
}, true);
document.addEventListener('llm-page-translator:detached-cleanup', (event) => {
  if (event instanceof CustomEvent && typeof event.detail === 'string') detachedSetterChecks.delete(Number(event.detail));
}, true);

async function fetchConfig(): Promise<ContentConfig> {
  return (await browser.runtime.sendMessage({ type: 'getConfig' })) as ContentConfig;
}

// ---------- port / backend ----------

function ensurePort(): Runtime.Port {
  if (port) return port;
  const p = browser.runtime.connect({ name: PORT_NAME });
  p.onMessage.addListener((m: unknown) => onPortMessage(m as PortOut));
  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    port = null;
    stopKeepalive();
    // Background restarted / extension reloaded: in-flight chunks can be retried.
    for (const c of chunks.values()) {
      if (c.state === 'checking' || c.state === 'busy') {
        if (c.state === 'busy') busy--;
        markError(c, {
          message: 'Connection to the extension background was lost',
          details: 'The background script was restarted or the extension was reloaded while this chunk was being checked or translated. Click Retry.',
        });
      }
    }
  });
  port = p;
  return p;
}

function post(msg: PortIn): void {
  ensurePort().postMessage(msg);
}

function startKeepalive(): void {
  // Periodic port traffic keeps Chromium's MV3 service worker (and Firefox's event page) alive during long requests.
  if (keepalive) return;
  keepalive = setInterval(() => {
    if (busy > 0 && port) port.postMessage({ type: 'ping' } satisfies PortIn);
    else stopKeepalive();
  }, KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
}

function onPortMessage(msg: PortOut): void {
  const chunk = chunks.get(msg.chunkId);
  const expectedState = msg.type === 'memoryHit' || msg.type === 'memoryMiss' ? 'checking' : 'busy';
  if (!chunk || (chunk.state !== expectedState && !(msg.type === 'error' && chunk.state === 'checking'))) {
    if (cfg?.textDiagnostics) {
      logTextDiagnostic('ignored chunk response', {
        chunkId: msg.chunkId,
        responseType: msg.type,
        known: !!chunk,
        state: chunk?.state,
      });
    }
    return;
  }
  if (msg.type === 'memoryMiss') {
    chunk.state = 'queued';
    setClasses(chunk);
    queue.push(chunk.id);
    if (cfg?.textDiagnostics) logTextDiagnostic('translation memory miss', { chunkId: chunk.id, segmentIds: chunk.segIds });
    pump();
    return;
  }
  const wasBusy = chunk.state === 'busy';
  if (cfg?.textDiagnostics) {
    logTextDiagnostic(msg.type === 'result' || msg.type === 'memoryHit' ? 'chunk result received' : 'chunk error received', {
      chunkId: msg.chunkId,
      segmentIds: chunk.segIds,
      ...(msg.type === 'result' || msg.type === 'memoryHit'
        ? { translationIds: Object.keys(msg.translations), source: msg.type === 'memoryHit' ? 'memory' : 'provider' }
        : { error: msg.error.message }),
    });
  }
  if (wasBusy) busy--;
  if (msg.type === 'result' || msg.type === 'memoryHit') {
    const inputGroupsToUpdate = new Set<InputGroup>();
    for (const id of chunk.segIds) {
      const seg = segs.get(id);
      if (!seg) {
        if (cfg?.textDiagnostics) logTextDiagnostic('segment update skipped', { chunkId: chunk.id, id, reason: 'segment no longer exists' });
        continue;
      }
      if (!seg.element.isConnected) {
        if (cfg?.textDiagnostics) {
          logTextDiagnostic('segment update skipped', {
            chunkId: chunk.id,
            id,
            reason: 'segment element disconnected before result',
            preview: diagnosticTextPreview(seg.raw),
          });
        }
        continue;
      }
      const { lead, core, trail } = splitWhitespace(seg.raw);
      if (seg.inputGroup) {
        seg.translation = msg.translations[id] ?? core;
        inputGroupsToUpdate.add(seg.inputGroup);
      } else {
        seg.translation = Object.hasOwn(msg.translations, id) ? msg.translations[id] : undefined;
        seg.element.textContent = lead + (msg.translations[id] ?? core) + trail;
        seg.element.title = core;
      }
      seg.element.classList.remove(...STATE_CLASSES);
      if (cfg?.textDiagnostics) {
        logTextDiagnostic('segment updated', {
          chunkId: chunk.id,
          id,
          translated: Object.hasOwn(msg.translations, id),
          preview: diagnosticTextPreview(seg.inputGroup ? seg.translation ?? core : seg.element.textContent),
        });
      }
    }
    for (const group of inputGroupsToUpdate) renderInputGroup(group, chunk.id);
    chunk.state = 'done';
    if (cfg?.textDiagnostics) logTextDiagnostic('chunk completed', { chunkId: chunk.id, state: chunk.state });
  } else {
    markError(chunk, msg.error);
  }
  pump();
}

function renderInputGroup(group: InputGroup, chunkId: number): void {
  if (group.input.value !== group.rendered) {
    if (cfg?.textDiagnostics) {
      logTextDiagnostic('input update skipped', {
        chunkId,
        path: group.input.id ? `input#${group.input.id}` : 'input',
        reason: 'value changed while translation was in progress',
      });
    }
    return;
  }
  const value = group.segments.map((seg) => {
    const { lead, core, trail } = splitWhitespace(seg.raw);
    return lead + (seg.translation ?? core) + trail;
  }).join('');
  group.input.value = value;
  group.rendered = value;
  if (cfg?.textDiagnostics) {
    logTextDiagnostic('input value updated', {
      inputId: group.input.id || undefined,
      preview: diagnosticTextPreview(value),
    });
  }
}

// ---------- chunk lifecycle ----------

function chunkSegs(c: Chunk): Seg[] {
  return c.segIds.map((id) => segs.get(id)).filter((s): s is Seg => !!s && s.element.isConnected);
}

function setClasses(c: Chunk, ...classes: string[]): void {
  const list = chunkSegs(c);
  list.forEach((s) => {
    s.element.classList.remove(...STATE_CLASSES);
    s.element.classList.add(...classes.filter((x) => x !== 'xt-spin'));
  });
  if (classes.includes('xt-spin')) list[list.length - 1]?.element.classList.add('xt-spin');
}

function clearBadge(c: Chunk): void {
  c.badge?.remove();
  c.badge = undefined;
}

function attachBadge(c: Chunk, badge: HTMLElement): void {
  clearBadge(c);
  const last = chunkSegs(c).pop();
  if (!last) return;
  last.element.after(badge);
  c.badge = badge;
}

function enqueue(c: Chunk): void {
  clearBadge(c);
  c.state = 'checking';
  setClasses(c);
  checkMemory(c);
}

function checkMemory(c: Chunk): void {
  const list = chunkSegs(c);
  if (!list.length) {
    c.state = 'done';
    if (cfg?.textDiagnostics) {
      logTextDiagnostic('chunk not checked', {
        chunkId: c.id,
        segmentIds: c.segIds,
        reason: 'no connected segments remain',
      });
    }
    return;
  }
  const segments: SegmentPayload[] = list.map((s) => ({ id: s.id, text: s.raw }));
  if (cfg?.textDiagnostics) {
    logTextDiagnostic('translation memory preflight', {
      chunkId: c.id,
      segmentIds: c.segIds,
      segmentCount: segments.length,
    });
  }
  try {
    post({ type: 'checkMemory', chunkId: c.id, segments, experimentalCachedTextContent: cfg?.experimentalCachedTextContent === true });
  } catch (e) {
    markError(c, {
      message: 'Cannot reach the extension background',
      details: `${String(e)}\n\nIf the extension was reloaded or updated, reload this page.`,
    });
  }
}

function inViewport(c: Chunk): boolean {
  const s = chunkSegs(c)[0];
  if (!s) return false;
  const r = s.element.getBoundingClientRect();
  return r.bottom >= 0 && r.top <= window.innerHeight;
}

function pump(): void {
  if (!active || !cfg) return;
  while (busy < cfg.concurrency && queue.length) {
    // Prefer chunks currently on screen so the user sees progress where they are reading.
    let idx = queue.findIndex((id) => {
      const c = chunks.get(id);
      return !!c && inViewport(c);
    });
    if (idx < 0) idx = 0;
    const [id] = queue.splice(idx, 1);
    const c = chunks.get(id);
    if (!c || c.state !== 'queued') continue;
    dispatch(c);
  }
}

function dispatch(c: Chunk): void {
  const list = chunkSegs(c);
  if (!list.length) {
    c.state = 'done';
    if (cfg?.textDiagnostics) {
      logTextDiagnostic('chunk not dispatched', {
        chunkId: c.id,
        segmentIds: c.segIds,
        reason: 'no connected segments remain',
      });
    }
    return;
  }
  c.state = 'busy';
  busy++;
  setClasses(c, 'xt-busy', 'xt-spin');
  const segments: SegmentPayload[] = list.map((s) => ({ id: s.id, text: s.raw }));
  if (cfg?.textDiagnostics) {
    logTextDiagnostic('chunk dispatched', {
      chunkId: c.id,
      segmentIds: c.segIds,
      segments: list.map((s) => ({ id: s.id, connected: s.element.isConnected, preview: diagnosticTextPreview(s.raw) })),
    });
  }
  try {
    post({ type: 'translate', chunkId: c.id, segments, experimentalCachedTextContent: cfg?.experimentalCachedTextContent === true });
    startKeepalive();
  } catch (e) {
    busy--;
    markError(c, {
      message: 'Cannot reach the extension background',
      details: `${String(e)}\n\nIf the extension was reloaded or updated, reload this page.`,
    });
  }
}

function markError(c: Chunk, error: ErrorInfo): void {
  c.state = 'error';
  setClasses(c, 'xt-error');
  attachBadge(
    c,
    createBadge({
      kind: 'error',
      title: 'Translation failed',
      message: error.message,
      details: error.details,
      actions: [{ label: 'Retry', primary: true, onClick: () => enqueue(c) }],
    }),
  );
}

function markOversized(c: Chunk): void {
  c.state = 'oversized';
  setClasses(c, 'xt-oversized');
  const max = cfg?.maxChunkSize ?? 0;
  attachBadge(
    c,
    createBadge({
      kind: 'oversized',
      title: 'Phrase too long for one chunk',
      message: `This phrase has ${c.size} characters, above the max chunk size of ${max}.`,
      actions: [
        {
          label: `Send as one chunk (${c.size})`,
          title: 'Increase the chunk size for this chunk only and translate the whole phrase at once',
          onClick: () => enqueue(c),
        },
        {
          label: 'Split',
          primary: true,
          title: 'Split at commas/semicolons/colons, then at words, into chunks within the limit',
          onClick: () => splitChunk(c),
        },
      ],
    }),
  );
}

function splitChunk(c: Chunk): void {
  if (!cfg) return;
  clearBadge(c);
  const newPayload: SegmentPayload[] = [];
  for (const seg of chunkSegs(c)) {
    const pieces = splitOversized(seg.raw, cfg.maxChunkSize);
    const newSegs = pieces.map((raw) => {
      const id = nextSegId++;
      const element = seg.inputGroup ? seg.inputGroup.input : createSegSpan(id, raw);
      const newSeg: Seg = {
        id,
        element,
        raw,
        domLevel: seg.domLevel,
        ...(seg.inputGroup ? { inputGroup: seg.inputGroup } : {}),
      };
      segs.set(id, newSeg);
      newPayload.push({ id, text: raw, domLevel: seg.domLevel });
      return newSeg;
    });
    if (seg.inputGroup) {
      const index = seg.inputGroup.segments.indexOf(seg);
      if (index >= 0) seg.inputGroup.segments.splice(index, 1, ...newSegs);
    } else {
      seg.element.replaceWith(...newSegs.map((newSeg) => newSeg.element));
    }
    segs.delete(seg.id);
  }
  chunks.delete(c.id);
  addChunks(newPayload);
}

function addChunks(payload: SegmentPayload[]): void {
  if (!cfg) return;
  const segmentsById = cfg.textDiagnostics ? new Map(payload.map((segment) => [segment.id, segment])) : undefined;
  if (cfg.textDiagnostics) {
    logTextDiagnostic('chunk input', payload.map((s) => ({
      id: s.id,
      domLevel: s.domLevel,
      length: s.text.trim().length,
      preview: diagnosticTextPreview(s.text),
    })));
  }
  const plans = buildChunks(payload, cfg.maxChunkSize);
  if (cfg.textDiagnostics) {
    logTextDiagnostic('chunks', plans.map((plan) => ({
      ids: plan.segmentIds,
      size: plan.size,
      oversized: plan.oversized,
      segments: plan.segmentIds.map((id) => {
        const segment = segmentsById?.get(id);
        return segment ? { id, domLevel: segment.domLevel, preview: diagnosticTextPreview(segment.text) } : { id };
      }),
    })));
  }
  for (const plan of plans) {
    const c: Chunk = { id: nextChunkId++, segIds: plan.segmentIds, size: plan.size, state: 'queued' };
    chunks.set(c.id, c);
    if (plan.oversized) markOversized(c);
    else enqueue(c);
  }
}

// ---------- scanning ----------

function scan(roots?: readonly (Element | Text)[]): void {
  if (!active || !document.body) return;
  const diagnostics = cfg?.textDiagnostics ?? false;
  const separateNumbers = cfg?.separateNumbers ?? false;
  const payload: SegmentPayload[] = [];
  const flush = () => {
    if (payload.length) addChunks(payload.splice(0));
  };
  const items = (roots ?? [document.body]).flatMap((root) => [
    ...scanTextNodes(root, diagnostics, separateNumbers).map(({ node, domLevel }) => ({ kind: 'text' as const, node, domLevel, root })),
    ...scanFormInputs(root, diagnostics, separateNumbers).map(({ input, domLevel }) => ({ kind: 'input' as const, node: input, domLevel, root })),
  ]).sort((a, b) => {
    const position = a.node.compareDocumentPosition(b.node);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  let previousRoot: Element | Text | undefined;
  for (const item of items) {
    if (separateNumbers && previousRoot && previousRoot !== item.root) flush();
    previousRoot = item.root;
    if (item.kind === 'text') {
      if (ignoredSliceText.get(item.node) === item.node.data) {
        if (separateNumbers && /\p{N}/u.test(item.node.data)) flush();
        if (diagnostics) logTextDiagnostic('scan ignored substring', { preview: diagnosticTextPreview(item.node.data) });
        continue;
      }
      const hasNumbers = separateNumbers && /\p{N}/u.test(item.node.data);
      if (hasNumbers) flush();
      if (hasNumbers && !/\p{L}/u.test(item.node.data)) continue;
      for (const w of wrapTextNode(item.node, () => nextSegId++, separateNumbers)) {
        if ('separator' in w) {
          flush();
          continue;
        }
        segs.set(w.id, { id: w.id, element: w.span, raw: w.raw, domLevel: item.domLevel });
        payload.push({ id: w.id, text: w.raw, domLevel: item.domLevel });
      }
      if (hasNumbers) flush();
    } else {
      const hasNumbers = separateNumbers && /\p{N}/u.test(item.node.value);
      if (hasNumbers) flush();
      if (scannedInputs.has(item.node)) continue;
      if (hasNumbers && !/\p{L}/u.test(item.node.value)) continue;
      scannedInputs.add(item.node);
      const group: InputGroup = {
        input: item.node,
        original: item.node.value,
        rendered: item.node.value,
        segments: [],
      };
      inputGroups.add(group);
      const parts = separateNumbers
        ? splitNumberSeparatedPhrases(item.node.value)
        : splitPhrases(item.node.value).map((raw) => ({ raw, kind: 'text' as const }));
      for (const { raw, kind } of parts) {
        const id = nextSegId++;
        const seg: Seg = { id, element: item.node, raw, domLevel: item.domLevel, inputGroup: group };
        group.segments.push(seg);
        if (kind !== 'text') {
          if (kind === 'number') flush();
          continue;
        }
        segs.set(id, seg);
        payload.push({ id, text: raw, domLevel: item.domLevel });
      }
      if (hasNumbers) flush();
    }
  }
  flush();
}

function isRelevantMutation(m: MutationRecord): boolean {
  if (isOwnNode(m.target)) return false;
  if (m.type === 'characterData') return m.target.nodeType === Node.TEXT_NODE || m.target.nodeType === Node.CDATA_SECTION_NODE;
  return Array.from(m.addedNodes).some((n) => !isOwnNode(n) && (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE));
}

const pendingSliceMutations = new Map<number, { target: Node; matched: boolean }>();
const pendingMutationRoots = new Set<Node>();

function isScanRoot(node: Node): node is Element | Text {
  return node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE;
}

function scanPendingMutations(): void {
  if (!document.body) {
    pendingMutationRoots.clear();
    return;
  }
  const candidates = [...pendingMutationRoots].filter((node): node is Element | Text =>
    isScanRoot(node) && document.body.contains(node) && !isOwnNode(node));
  pendingMutationRoots.clear();
  const candidateSet = new Set<Node>(candidates);
  const roots = candidates.filter((node) => {
    for (let parent = node.parentNode; parent && parent !== document.body; parent = parent.parentNode) {
      if (candidateSet.has(parent)) return false;
    }
    return true;
  }).sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  if (roots.length) scan(roots);
}

function processMutationRecords(records: MutationRecord[]): void {
  if (!records.length) return;
  const suppressed = new Set<MutationRecord>();
  for (const record of records) {
    const pending = [...pendingSliceMutations.values()].reverse().find((entry) =>
      !entry.matched &&
      entry.target === record.target &&
      record.type === (entry.target.nodeType === Node.TEXT_NODE || entry.target.nodeType === Node.CDATA_SECTION_NODE
        ? 'characterData'
        : 'childList'),
    );
    if (pending) {
      pending.matched = true;
      suppressed.add(record);
      if (record.type === 'characterData' && record.target instanceof Text) {
        ignoredSliceText.set(record.target, record.target.data);
      } else {
        for (const node of record.addedNodes) {
          if (node instanceof Text) ignoredSliceText.set(node, node.data);
        }
      }
    } else if (record.type === 'characterData' && record.target instanceof Text) {
      ignoredSliceText.delete(record.target);
    }
  }
  const analysis = analyzeMutationBatch(
    records,
    (record) => !suppressed.has(record) && isRelevantMutation(record),
    !!cfg?.textDiagnostics,
  );
  const debounceAction = analysis.hasRelevantRecords
    ? debounce ? 'restarted' : 'scheduled'
    : 'unchanged';
  if (analysis.relevantRecords) {
    logTextDiagnostic('mutation observer', {
      recordCount: records.length,
      relevantRecordCount: analysis.relevantRecords.length,
      ignoredRecordCount: records.length - analysis.relevantRecords.length,
      childListRecords: records.filter((record) => record.type === 'childList').length,
      characterDataRecords: records.filter((record) => record.type === 'characterData').length,
      debounceAction,
      mutations: records.map((record) => ({
        ...diagnosticMutation(record),
        ...(suppressed.has(record) ? { sliceWrapper: true, isSubstring: true } : {}),
      })),
    });
  }
  if (!analysis.hasRelevantRecords) return;
  for (const record of records) {
    if (suppressed.has(record) || !isRelevantMutation(record)) continue;
    if (record.type === 'characterData') {
      pendingMutationRoots.add(record.target);
    } else {
      for (const node of record.addedNodes) {
        if (isScanRoot(node) && !isOwnNode(node)) pendingMutationRoots.add(node);
      }
    }
  }
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    scanPendingMutations();
  }, MUTATION_DEBOUNCE_MS);
}

document.addEventListener('llm-page-translator:slice-before', (event) => {
  if (!active || !cfg?.experimentalSliceGuard || !observer || !(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
  const id = Number(event.detail);
  if (!Number.isInteger(id) || id < 1 || !(event.target instanceof Node)) return;
  processMutationRecords(observer.takeRecords());
  pendingSliceMutations.set(id, { target: event.target, matched: false });
}, true);
document.addEventListener('llm-page-translator:slice-after', (event) => {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
  const id = Number(event.detail);
  if (!pendingSliceMutations.has(id)) return;
  if (observer) processMutationRecords(observer.takeRecords());
  pendingSliceMutations.delete(id);
}, true);

function startObserver(): void {
  if (observer || !document.body) return;
  observer = new MutationObserver(processMutationRecords);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  pendingSliceMutations.clear();
  pendingMutationRoots.clear();
  ignoredSliceText = new WeakMap<Text, string>();
  if (debounce) clearTimeout(debounce);
  debounce = null;
}

// ---------- public actions ----------

async function start(): Promise<void> {
  const pending = { changes: [] as { key: string; value: unknown }[], invalidated: false };
  pendingIndex = pending;
  memoryIndex = null;
  cachedChunks.clear();
  try {
    cfg = await fetchConfig();
  } catch (error) {
    if (pendingIndex === pending) pendingIndex = null;
    throw error;
  }
  if (cfg.translateDynamic && cfg.experimentalCachedTextContent) await loadMemoryIndex(pending);
  else if (pendingIndex === pending) pendingIndex = null;
  if (cfg.enableSetterHooks) {
    if (!setterGuardInstalled) await browser.runtime.sendMessage({ type: 'installSetterGuard' });
    if (document.dispatchEvent(new CustomEvent('llm-page-translator:setter-guard-start', {
      cancelable: true,
      detail: cfg.experimentalSliceGuard ? 'slice' : '',
    }))) {
      throw new Error('Could not activate the page setter guard');
    }
    setterGuardInstalled = true;
  } else if (setterGuardInstalled) {
    document.dispatchEvent(new Event('llm-page-translator:setter-guard-stop'));
  }
  active = true;
  injectStyles();
  scan();
  if (cfg.translateDynamic) startObserver();
  else stopObserver();
}

function restore(): void {
  active = false;
  pendingIndex = null;
  memoryIndex = null;
  cachedChunks.clear();
  detachedSetterChecks.clear();
  document.dispatchEvent(new Event('llm-page-translator:setter-guard-stop'));
  stopObserver();
  stopKeepalive();
  for (const c of chunks.values()) {
    if (c.state === 'busy' && port) port.postMessage({ type: 'cancel', chunkId: c.id } satisfies PortIn);
  }
  port?.disconnect();
  port = null;
  for (const group of inputGroups) {
    if (group.input.value === group.rendered) group.input.value = group.original;
    group.input.classList.remove(...STATE_CLASSES);
  }
  inputGroups.clear();
  scannedInputs = new WeakSet<HTMLInputElement>();
  restoreAll();
  removeStyles();
  segs.clear();
  chunks.clear();
  queue = [];
  busy = 0;
}

function retryErrors(): void {
  for (const c of chunks.values()) if (c.state === 'error') enqueue(c);
}

function status(): PageStatus {
  const s: PageStatus = { active, total: 0, done: 0, busy: 0, queued: 0, errors: 0, oversized: 0 };
  for (const c of chunks.values()) {
    s.total++;
    if (c.state === 'done') s.done++;
    else if (c.state === 'busy') s.busy++;
    else if (c.state === 'queued' || c.state === 'checking') s.queued++;
    else if (c.state === 'error') s.errors++;
    else if (c.state === 'oversized') s.oversized++;
  }
  return s;
}

browser.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as TabRequest;
  switch (msg?.type) {
    case 'start':
      return start().then(status);
    case 'restore':
      restore();
      return Promise.resolve(status());
    case 'retryErrors':
      retryErrors();
      return Promise.resolve(status());
    case 'invalidateMemoryIndex':
      invalidateMemoryIndex();
      return Promise.resolve(status());
    case 'status':
      return Promise.resolve(status());
    case 'setDiagnostics':
      if (cfg) cfg = { ...cfg, textDiagnostics: msg.enabled };
      if (msg.enabled) {
        logTextDiagnostic('diagnostics enabled', { note: 'Text previews are included in this tab console.' });
        if (active) {
          logTextDiagnostic('existing segments', [...segs.values()].map((seg) => ({
            id: seg.id,
            domLevel: seg.domLevel,
            preview: diagnosticTextPreview(seg.raw),
          })));
          logTextDiagnostic('existing chunks', [...chunks.values()].map((chunk) => ({
            ids: chunk.segIds,
            state: chunk.state,
            size: chunk.size,
          })));
          scan();
        }
      }
      return Promise.resolve(status());
    default:
      return undefined;
  }
});

fetchConfig()
  .then((c) => {
    if (c.autoTranslate && !active) return start();
  })
  .catch((error) => console.error('[LLM Page Translator] Could not start automatic translation', error));
