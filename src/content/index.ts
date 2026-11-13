import type { Runtime } from 'webextension-polyfill';
import { browser } from '../shared/browser';
import { buildChunks } from '../shared/chunker';
import { splitOversized, splitPhrases } from '../shared/phrases';
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
import { createSegSpan, isOwnNode, matchesOriginalInnerHTML, originalTextContent, restoreAll, scanFormInputs, scanTextNodes, splitWhitespace, wrapTextNode } from './dom';
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

function setterMatches(target: Node, type: string, value: string): boolean {
  if (type === 'llm-page-translator:check-text-content' || type === 'llm-page-translator:detached-text') {
    return originalTextContent(target) === value;
  }
  return target instanceof Element && matchesOriginalInnerHTML(target, value);
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
    post({ type: 'checkMemory', chunkId: c.id, segments });
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
    post({ type: 'translate', chunkId: c.id, segments });
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

function scan(): void {
  if (!active || !document.body) return;
  const diagnostics = cfg?.textDiagnostics ?? false;
  const payload: SegmentPayload[] = [];
  const items = [
    ...scanTextNodes(document.body, diagnostics).map(({ node, domLevel }) => ({ kind: 'text' as const, node, domLevel })),
    ...scanFormInputs(document.body, diagnostics).map(({ input, domLevel }) => ({ kind: 'input' as const, node: input, domLevel })),
  ].sort((a, b) => {
    const position = a.node.compareDocumentPosition(b.node);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  for (const item of items) {
    if (item.kind === 'text') {
      if (ignoredSliceText.get(item.node) === item.node.data) {
        if (diagnostics) logTextDiagnostic('scan ignored substring', { preview: diagnosticTextPreview(item.node.data) });
        continue;
      }
      for (const w of wrapTextNode(item.node, () => nextSegId++)) {
        segs.set(w.id, { id: w.id, element: w.span, raw: w.raw, domLevel: item.domLevel });
        payload.push({ id: w.id, text: w.raw, domLevel: item.domLevel });
      }
    } else {
      if (scannedInputs.has(item.node)) continue;
      scannedInputs.add(item.node);
      const group: InputGroup = {
        input: item.node,
        original: item.node.value,
        rendered: item.node.value,
        segments: [],
      };
      inputGroups.add(group);
      for (const raw of splitPhrases(item.node.value)) {
        const id = nextSegId++;
        const seg: Seg = { id, element: item.node, raw, domLevel: item.domLevel, inputGroup: group };
        group.segments.push(seg);
        segs.set(id, seg);
        payload.push({ id, text: raw, domLevel: item.domLevel });
      }
    }
  }
  addChunks(payload);
}

function isRelevantMutation(m: MutationRecord): boolean {
  if (isOwnNode(m.target)) return false;
  if (m.type === 'characterData') return true;
  return Array.from(m.addedNodes).some((n) => !isOwnNode(n) && (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE));
}

const pendingSliceMutations = new Map<number, { target: Node; matched: boolean }>();

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
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    scan();
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
  ignoredSliceText = new WeakMap<Text, string>();
  if (debounce) clearTimeout(debounce);
  debounce = null;
}

// ---------- public actions ----------

async function start(): Promise<void> {
  cfg = await fetchConfig();
  if (!setterGuardInstalled) await browser.runtime.sendMessage({ type: 'installSetterGuard' });
  if (document.dispatchEvent(new CustomEvent('llm-page-translator:setter-guard-start', {
    cancelable: true,
    detail: cfg.experimentalSliceGuard ? 'slice' : '',
  }))) {
    throw new Error('Could not activate the page setter guard');
  }
  setterGuardInstalled = true;
  active = true;
  injectStyles();
  scan();
  if (cfg.translateDynamic) startObserver();
  else stopObserver();
}

function restore(): void {
  active = false;
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
