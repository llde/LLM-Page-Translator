import { splitNumberSeparatedPhrases, splitPhrases } from '../shared/phrases';
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
const HAS_NUMBER = /\p{N}/u;
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

export function canTranslateTextAssignment(node: Node, value: string): boolean {
  if (!document.body?.contains(node) || isOwnNode(node) || !value.trim() || !HAS_LETTER.test(value)) return false;
  const parent = node.nodeType === Node.ELEMENT_NODE ? node as Element
    : node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
  if (!parent) return false;
  for (let element: Element | null = parent; element && element !== document.body; element = element.parentElement) {
    if (elementRejectionReason(element)) return false;
  }
  return true;
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
export function scanTextNodes(root: Element | Text, diagnostics = false, separateNumbers = false): ScannedTextNode[] {
  const out: ScannedTextNode[] = [];
  const rootElement = root.nodeType === Node.ELEMENT_NODE ? root as Element : root.parentElement;
  for (let element = rootElement; element && element !== document.body; element = element.parentElement) {
    const reason = elementRejectionReason(element);
    if (reason) {
      if (diagnostics) logTextDiagnostic('scan rejected subtree', { path: diagnosticElementPath(element), reason });
      return out;
    }
  }
  const acceptNode = (node: Node): number => {
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
    if (!HAS_LETTER.test(t) && !(separateNumbers && HAS_NUMBER.test(t))) {
      if (diagnostics) logTextDiagnostic('scan rejected text', { path, reason: 'contains no letters', preview: diagnosticTextPreview(t) });
      return NodeFilter.FILTER_REJECT;
    }
    if (diagnostics) {
      logTextDiagnostic('scan accepted text', { path, preview: diagnosticTextPreview(t) });
    }
    return NodeFilter.FILTER_ACCEPT;
  };
  const addNode = (node: Text) => {
    let domLevel = 0;
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) domLevel++;
    out.push({ node, domLevel });
  };
  if (diagnostics) {
    const path = rootElement ? diagnosticElementPath(rootElement) : '';
    logTextDiagnostic('scan started', { root: root.nodeType === Node.ELEMENT_NODE ? path : `${path} > #text` });
  }
  if (root.nodeType === Node.TEXT_NODE || root.nodeType === Node.CDATA_SECTION_NODE) {
    if (acceptNode(root) === NodeFilter.FILTER_ACCEPT) addNode(root as Text);
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) addNode(node as Text);
  }
  if (diagnostics) logTextDiagnostic('scan completed', { acceptedTextNodes: out.length });
  return out;
}

/** Collect visible, unnamed text-entry inputs in forms when they have an explicit value. */
export function scanFormInputs(root: Element | Text, diagnostics = false, separateNumbers = false): ScannedInput[] {
  const out: ScannedInput[] = [];
  if (root.nodeType !== Node.ELEMENT_NODE) return out;
  const elementRoot = root as Element;
  if (diagnostics) logTextDiagnostic('input scan started', { root: diagnosticElementPath(elementRoot) });
  const inputs = [
    ...(elementRoot.tagName === 'INPUT' ? [elementRoot as HTMLInputElement] : []),
    ...elementRoot.querySelectorAll<HTMLInputElement>('input'),
  ];
  for (const input of inputs) {
    let reason: string | undefined;
    if (!TRANSLATABLE_INPUT_TYPES.has(input.type)) reason = 'excluded input type';
    else if (!input.closest('form')) reason = 'not inside a form';
    else if (input.hasAttribute('name')) reason = 'has a name attribute';
    else if (input.matches(':disabled')) reason = 'disabled input';
    else if (!input.hasAttribute('value')) reason = 'missing value attribute';
    else if (input.closest('[translate="no"], .notranslate')) reason = 'translation disabled by page';
    else if (!isVisible(input)) reason = 'not visible';
    else if (!input.value.trim()) reason = 'empty or whitespace only';
    else if (!HAS_LETTER.test(input.value) && !(separateNumbers && HAS_NUMBER.test(input.value))) reason = 'contains no letters';

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
    for (let element: Element | null = input; element && element !== document.body; element = element.parentElement) domLevel++;
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
  originals.set(span, raw);
  return span;
}

export function createWrappedText(value: string, nextId: () => number, separateNumbers = false, whole = false): {
  container: HTMLSpanElement;
  segments: (WrappedSegment | { separator: true })[];
} {
  const container = document.createElement('span');
  container.className = NODE_CLASS;
  originals.set(container, value);
  const segs: (WrappedSegment | { separator: true })[] = [];
  const parts = whole ? [{ raw: value, kind: 'text' as const }] : separateNumbers
    ? splitNumberSeparatedPhrases(value)
    : splitPhrases(value).map((raw) => ({ raw, kind: 'text' as const }));
  for (const { raw, kind } of parts) {
    if (kind !== 'text') {
      container.appendChild(document.createTextNode(raw));
      if (kind === 'number') segs.push({ separator: true });
      continue;
    }
    const id = nextId();
    const span = createSegSpan(id, raw);
    container.appendChild(span);
    segs.push({ id, span, raw });
  }
  return { container, segments: segs };
}

/** Replace a text node with `span.xt-node > span.xt-seg*` (one per phrase). */
export function wrapTextNode(text: Text, nextId: () => number, separateNumbers = false): (WrappedSegment | { separator: true })[] {
  const { container, segments } = createWrappedText(text.nodeValue ?? '', nextId, separateNumbers);
  text.replaceWith(container);
  return segments;
}

/** Restore every wrapped text node to its original content (also removes badges inside wrappers). */
export function restoreAll(): void {
  document.querySelectorAll<HTMLElement>(`.${NODE_CLASS}`).forEach((c) => {
    const orig = originals.get(c);
    if (orig !== undefined) c.replaceWith(document.createTextNode(orig));
  });
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((b) => b.remove());
}

export function originalTextContent(node: Node): string | null {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const original = originals.get(node as HTMLElement);
    if (original !== undefined) return original;
  }
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    const parent = node.parentElement;
    if (parent?.classList.contains(SEG_CLASS) && parent.childNodes.length === 1) {
      const original = originals.get(parent);
      if (original !== undefined) return original;
    }
    return node.nodeValue;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return node.textContent;
  return Array.from(node.childNodes, (child) =>
    child.nodeType === Node.COMMENT_NODE || child.nodeType === Node.PROCESSING_INSTRUCTION_NODE
      ? ''
      : originalTextContent(child) ?? '',
  ).join('');
}

export function originalInnerHTML(element: Element): string {
  const original = originals.get(element as HTMLElement);
  if (original !== undefined) {
    const inertDocument = document.implementation.createHTMLDocument('');
    const container = inertDocument.createElement('span');
    container.append(inertDocument.createTextNode(original));
    return container.innerHTML;
  }
  const wrappers = Array.from(element.querySelectorAll<HTMLElement>(`.${NODE_CLASS}`));
  if (!wrappers.some((wrapper) => originals.has(wrapper))) return element.innerHTML;
  const inertDocument = document.implementation.createHTMLDocument('');
  const copy = inertDocument.importNode(element, true);
  const copiedWrappers = copy.querySelectorAll<HTMLElement>(`.${NODE_CLASS}`);
  wrappers.forEach((wrapper, index) => {
    const original = originals.get(wrapper);
    if (original !== undefined) copiedWrappers[index].replaceWith(inertDocument.createTextNode(original));
  });
  return copy.innerHTML;
}

export function matchesOriginalInnerHTML(element: Element, value: string): boolean {
  const original = originalInnerHTML(element);
  if (original === value) return true;
  const inertDocument = document.implementation.createHTMLDocument('');
  const copy = inertDocument.importNode(element, false);
  try {
    copy.innerHTML = value;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'SyntaxError')) return false;
    throw error;
  }
  return copy.innerHTML === original;
}

interface TranslatedSegment {
  raw: string;
  translation?: string;
}

const FORMATTED_NUMBER = /[+\-\u2212]?\p{N}+(?:[.,'\u2019\u066b\u066c\u00a0\u2009\u202f]\p{N}+)*/gu;

function numberMatches(text: string): RegExpMatchArray[] {
  return Array.from(text.matchAll(FORMATTED_NUMBER));
}

function replaceNumberParts(parts: string[], numbers: RegExpMatchArray[], replacements: string[]): string[] {
  const result = [...parts];
  const offsets: number[] = [];
  let length = 0;
  for (const part of parts) {
    offsets.push(length);
    length += part.length;
  }
  for (let n = numbers.length - 1; n >= 0; n--) {
    const start = numbers[n].index!;
    const end = start + numbers[n][0].length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const from = Math.max(start, offsets[i]);
      const to = Math.min(end, offsets[i] + parts[i].length);
      if (from >= to) continue;
      const localStart = from - offsets[i];
      const localEnd = to - offsets[i];
      result[i] = result[i].slice(0, localStart) +
        (from === start ? replacements[n] : '') + result[i].slice(localEnd);
    }
  }
  return result;
}

/**
 * Preserve translated nodes only if all numeric substitutions can be mapped to
 * the original and rendered text without guessing how the translation used them.
 */
export function preserveTranslatedInnerHTML(
  element: Element,
  value: string,
  getSegment: (element: HTMLElement) => TranslatedSegment | undefined,
): boolean {
  if (originals.has(element as HTMLElement)) return false;
  const inertDocument = document.implementation.createHTMLDocument('');
  const incoming = inertDocument.importNode(element, false);
  try {
    incoming.innerHTML = value;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'SyntaxError')) return false;
    throw error;
  }
  const updates: (() => void)[] = [];
  let hasTranslation = false;

  const compareText = (node: Node, replacement: string): boolean => {
    const wrapper = node.nodeType === Node.ELEMENT_NODE && originals.has(node as HTMLElement)
      ? node as HTMLElement : undefined;
    const original = wrapper ? originals.get(wrapper)! : node.nodeValue ?? '';
    if ((original.match(/\p{L}/gu) ?? []).join('') !== (replacement.match(/\p{L}/gu) ?? []).join('')) return false;
    const oldNumbers = numberMatches(original);
    const newNumbers = numberMatches(replacement);
    if (oldNumbers.length !== newNumbers.length) return false;
    const replacements = newNumbers.map((number) => number[0]);
    const repeated = new Map<string, string>();
    for (let i = 0; i < oldNumbers.length; i++) {
      const old = oldNumbers[i][0];
      if (repeated.has(old) && repeated.get(old) !== replacements[i]) return false;
      repeated.set(old, replacements[i]);
    }
    if (!wrapper) {
      if (/\p{L}/u.test(original) || node.nodeType !== Node.TEXT_NODE) return false;
      const updated = replaceNumberParts([original], oldNumbers, replacements)[0];
      if (updated !== original) updates.push(() => { node.nodeValue = updated; });
      return true;
    }

    const rawParts: string[] = [];
    const renderedParts: string[] = [];
    const pieces: { text: Text; segment?: TranslatedSegment; element?: HTMLElement }[] = [];
    for (const child of wrapper.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        rawParts.push(child.nodeValue ?? '');
        renderedParts.push(child.nodeValue ?? '');
        pieces.push({ text: child as Text });
      } else if (child instanceof HTMLElement && child.classList.contains(SEG_CLASS)) {
        const segment = getSegment(child);
        if (!segment || segment.translation === undefined || child.childNodes.length !== 1 || !(child.firstChild instanceof Text)) return false;
        const { lead, trail } = splitWhitespace(segment.raw);
        if (child.textContent !== lead + segment.translation + trail || originals.get(child) !== segment.raw) return false;
        rawParts.push(segment.raw);
        renderedParts.push(child.textContent);
        pieces.push({ text: child.firstChild, segment, element: child });
        hasTranslation = true;
      } else {
        return false;
      }
    }
    if (rawParts.join('') !== original) return false;
    const renderedNumbers = numberMatches(renderedParts.join(''));
    if (renderedNumbers.length !== oldNumbers.length ||
      renderedNumbers.some((number, i) => number[0] !== oldNumbers[i][0])) return false;
    const newRawParts = replaceNumberParts(rawParts, oldNumbers, replacements);
    const newRenderedParts = replaceNumberParts(renderedParts, renderedNumbers, replacements);
    const newTranslations: (string | undefined)[] = [];
    for (let i = 0; i < pieces.length; i++) {
      if (!pieces[i].segment) {
        if (newRawParts[i] !== newRenderedParts[i]) return false;
        newTranslations.push(undefined);
        continue;
      }
      const { lead, trail } = splitWhitespace(newRawParts[i]);
      const rendered = newRenderedParts[i];
      if (!rendered.startsWith(lead) || !rendered.endsWith(trail) || rendered.length < lead.length + trail.length) return false;
      newTranslations.push(rendered.slice(lead.length, rendered.length - trail.length));
    }
    updates.push(() => {
      originals.set(wrapper, newRawParts.join(''));
      pieces.forEach(({ text, segment, element: span }, i) => {
        if (text.data !== newRenderedParts[i]) text.data = newRenderedParts[i];
        if (segment && span) {
          segment.raw = newRawParts[i];
          segment.translation = newTranslations[i];
          originals.set(span, segment.raw);
          span.title = splitWhitespace(segment.raw).core;
        }
      });
    });
    return true;
  };

  const compareChildren = (oldParent: Node, newParent: Node): boolean => {
    const oldChildren = Array.from(oldParent.childNodes);
    const newChildren = Array.from(newParent.childNodes);
    if (oldChildren.length !== newChildren.length) return false;
    return oldChildren.every((oldChild, i) => {
      const newChild = newChildren[i];
      if (oldChild.nodeType === Node.TEXT_NODE || (oldChild.nodeType === Node.ELEMENT_NODE && originals.has(oldChild as HTMLElement))) {
        return newChild.nodeType === Node.TEXT_NODE && compareText(oldChild, newChild.nodeValue ?? '');
      }
      if (oldChild.nodeType !== newChild.nodeType || !oldChild.cloneNode(false).isEqualNode(newChild.cloneNode(false))) return false;
      return compareChildren(oldChild, newChild);
    });
  };

  if (!compareChildren(element, incoming) || !hasTranslation) return false;
  updates.forEach((update) => update());
  return true;
}

/** Split a raw phrase into leading whitespace, core text and trailing whitespace. */
export function splitWhitespace(raw: string): { lead: string; core: string; trail: string } {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
  return { lead: m[1], core: m[2], trail: m[3] };
}
