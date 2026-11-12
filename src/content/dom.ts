import { splitPhrases } from '../shared/phrases';
import { diagnosticElementPath, diagnosticTextPreview, logTextDiagnostic } from './diagnostics';

export const NODE_CLASS = 'xt-node';
export const SEG_CLASS = 'xt-seg';
export const BADGE_CLASS = 'xt-badge-host';
const OWN_SELECTOR = `.${NODE_CLASS}, .${BADGE_CLASS}`;

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
  'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK',
]);

const HAS_LETTER = /\p{L}/u;
const TRANSLATABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'submit']);

/** Original text of each wrapper, used to restore the page. */
const originals = new WeakMap<HTMLElement, string>();

export function isOwnNode(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement;
  return !!el?.closest(OWN_SELECTOR);
}

function isVisible(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    return anyEl.checkVisibility({ visibilityProperty: true });
  }
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  return el.getClientRects().length > 0 || cs.display === 'contents';
}

function elementRejectionReason(el: Element): string | undefined {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return 'excluded element type';
  if (el.matches(OWN_SELECTOR)) return 'extension-generated element';
  if ((el as HTMLElement).isContentEditable) return 'editable element';
  if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return 'translation disabled by page';
  if (!isVisible(el)) return 'not visible';
  return undefined;
}

export interface ScannedTextNode {
  node: Text;
  domLevel: number;
}

export interface ScannedInput {
  input: HTMLInputElement;
  domLevel: number;
}

/** Collect visible, translatable text nodes under root with their depth, in document order. */
export function scanTextNodes(root: Element, diagnostics = false): ScannedTextNode[] {
  const out: ScannedTextNode[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const reason = elementRejectionReason(el);
        if (reason) {
          if (diagnostics) logTextDiagnostic('scan rejected subtree', { path: diagnosticElementPath(el), reason });
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      const t = node.nodeValue ?? '';
      const parent = (node as Text).parentElement;
      const path = parent ? diagnosticElementPath(parent) : '';
      if (!t.trim()) {
        if (diagnostics) logTextDiagnostic('scan rejected text', { path, reason: 'empty or whitespace only' });
        return NodeFilter.FILTER_REJECT;
      }
      if (!HAS_LETTER.test(t)) {
        if (diagnostics) logTextDiagnostic('scan rejected text', { path, reason: 'contains no letters', preview: diagnosticTextPreview(t) });
        return NodeFilter.FILTER_REJECT;
      }
      if (diagnostics) {
        logTextDiagnostic('scan accepted text', { path, preview: diagnosticTextPreview(t) });
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  if (diagnostics) logTextDiagnostic('scan started', { root: diagnosticElementPath(root) });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    let domLevel = 0;
    for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) domLevel++;
    out.push({ node, domLevel });
  }
  if (diagnostics) logTextDiagnostic('scan completed', { acceptedTextNodes: out.length });
  return out;
}

/** Collect visible, unnamed text-entry inputs in forms when they have an explicit value. */
export function scanFormInputs(root: Element, diagnostics = false): ScannedInput[] {
  const out: ScannedInput[] = [];
  if (diagnostics) logTextDiagnostic('input scan started', { root: diagnosticElementPath(root) });
  for (const input of root.querySelectorAll<HTMLInputElement>('input')) {
    let reason: string | undefined;
    if (!TRANSLATABLE_INPUT_TYPES.has(input.type)) reason = 'excluded input type';
    else if (!input.closest('form')) reason = 'not inside a form';
    else if (input.hasAttribute('name')) reason = 'has a name attribute';
    else if (input.matches(':disabled')) reason = 'disabled input';
    else if (!input.hasAttribute('value')) reason = 'missing value attribute';
    else if (input.closest('[translate="no"], .notranslate')) reason = 'translation disabled by page';
    else if (!isVisible(input)) reason = 'not visible';
    else if (!input.value.trim()) reason = 'empty or whitespace only';
    else if (!HAS_LETTER.test(input.value)) reason = 'contains no letters';

    if (reason) {
      if (diagnostics) {
        logTextDiagnostic('input scan rejected', {
          path: diagnosticElementPath(input),
          reason,
          preview: diagnosticTextPreview(input.value),
        });
      }
      continue;
    }

    let domLevel = 0;
    for (let element: Element | null = input; element && element !== root; element = element.parentElement) domLevel++;
    out.push({ input, domLevel });
    if (diagnostics) {
      logTextDiagnostic('input scan accepted', {
        path: diagnosticElementPath(input),
        preview: diagnosticTextPreview(input.value),
      });
    }
  }
  if (diagnostics) logTextDiagnostic('input scan completed', { acceptedInputs: out.length });
  return out;
}

export interface WrappedSegment {
  id: number;
  span: HTMLSpanElement;
  /** Original phrase including surrounding whitespace. */
  raw: string;
}

export function createSegSpan(id: number, raw: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = SEG_CLASS;
  span.dataset.xtId = String(id);
  span.textContent = raw;
  return span;
}

/** Replace a text node with `span.xt-node > span.xt-seg*` (one per phrase). */
export function wrapTextNode(text: Text, nextId: () => number): WrappedSegment[] {
  const value = text.nodeValue ?? '';
  const container = document.createElement('span');
  container.className = NODE_CLASS;
  originals.set(container, value);
  const segs: WrappedSegment[] = [];
  for (const raw of splitPhrases(value)) {
    const id = nextId();
    const span = createSegSpan(id, raw);
    container.appendChild(span);
    segs.push({ id, span, raw });
  }
  text.replaceWith(container);
  return segs;
}

/** Restore every wrapped text node to its original content (also removes badges inside wrappers). */
export function restoreAll(): void {
  document.querySelectorAll<HTMLElement>(`.${NODE_CLASS}`).forEach((c) => {
    const orig = originals.get(c);
    if (orig !== undefined) c.replaceWith(document.createTextNode(orig));
  });
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((b) => b.remove());
}

/** Split a raw phrase into leading whitespace, core text and trailing whitespace. */
export function splitWhitespace(raw: string): { lead: string; core: string; trail: string } {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
  return { lead: m[1], core: m[2], trail: m[3] };
}
