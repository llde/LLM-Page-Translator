const CHECK_TEXT = 'llm-page-translator:check-text-content';
const CHECK_HTML = 'llm-page-translator:check-inner-html';
const START = 'llm-page-translator:setter-guard-start';
const STOP = 'llm-page-translator:setter-guard-stop';
const DETACHED_TEXT = 'llm-page-translator:detached-text';
const DETACHED_HTML = 'llm-page-translator:detached-html';
const DETACHED_TARGET = 'llm-page-translator:detached-target';
const DETACHED_CLEANUP = 'llm-page-translator:detached-cleanup';
const SLICE_BEFORE = 'llm-page-translator:slice-before';
const SLICE_AFTER = 'llm-page-translator:slice-after';

let nativeSlice: typeof String.prototype.slice = String.prototype.slice;
let sliceDescriptor: PropertyDescriptor | undefined;

class SliceString {
  readonly #value: string;
  readonly #isSubstring: boolean;

  constructor(value: string, isSubstring: boolean) {
    this.#value = value;
    this.#isSubstring = isSubstring;
  }

  get value(): string {
    return this.#value;
  }

  get isSubstring(): boolean {
    return this.#isSubstring;
  }

  toString(): string {
    return this.#value;
  }

  valueOf(): string {
    return this.#value;
  }

  equals(other: unknown): boolean {
    const otherValue = typeof other === 'string'
      ? other
      : isSliceString(other) ? other.value : undefined;
    return this.#value === otherValue;
  }
}

function isSliceString(value: unknown): value is SliceString {
  return typeof value === 'object' && value !== null &&
    value.constructor?.name === SliceString.name &&
    'value' in value && typeof value.value === 'string' &&
    'isSubstring' in value && typeof value.isSubstring === 'boolean';
}

function experimentalSlice(this: unknown, start?: number, end?: number): SliceString {
  'use strict';
  if (this === null || this === undefined) throw new TypeError('String.prototype.slice called on null or undefined');
  const source = `${this}`;
  const value = nativeSlice.call(source, start, end);
  return new SliceString(value, value !== source);
}

function configureSlice(enabled: boolean): void {
  const current = Object.getOwnPropertyDescriptor(String.prototype, 'slice');
  if (enabled) {
    if (current?.value === experimentalSlice) return;
    if (!current || typeof current.value !== 'function') throw new Error('Cannot guard String.prototype.slice');
    nativeSlice = current.value;
    sliceDescriptor = current;
    Object.defineProperty(String.prototype, 'slice', { ...current, value: experimentalSlice });
  } else {
    if (current?.value === experimentalSlice && sliceDescriptor) Object.defineProperty(String.prototype, 'slice', sliceDescriptor);
    sliceDescriptor = undefined;
  }
}

let nextRequestId = 0;

function checkDetached(target: Node, eventType: string, value: string): boolean {
  nextRequestId = nextRequestId >= 0x7fffffff ? 1 : nextRequestId + 1;
  const requestId = nextRequestId;
  const requestType = eventType === CHECK_TEXT ? DETACHED_TEXT : DETACHED_HTML;
  try {
    document.dispatchEvent(new CustomEvent(requestType, { detail: `${requestId}:${value}` }));
    return !document.dispatchEvent(new FocusEvent(DETACHED_TARGET, {
      detail: requestId,
      relatedTarget: target,
      cancelable: true,
    }));
  } finally {
    document.dispatchEvent(new CustomEvent(DETACHED_CLEANUP, { detail: `${requestId}` }));
  }
}

function guardSetter(prototype: object, property: string, eventType: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
  if (!descriptor?.set || !descriptor.get) throw new Error(`Cannot guard ${property}: missing native accessor`);
  const nativeSet = descriptor.set;
  let installed = true;
  const guardedSet = function (this: Node, value: unknown) {
    if (!installed) {
      nativeSet.call(this, value);
      return;
    }
    const slice = isSliceString(value) ? value : undefined;
    if (slice) value = slice.value;
    if (state.active && state.experimentalSliceGuard && slice?.isSubstring && eventType === CHECK_TEXT) {
      nextRequestId = nextRequestId >= 0x7fffffff ? 1 : nextRequestId + 1;
      const requestId = nextRequestId;
      if (this.isConnected) this.dispatchEvent(new CustomEvent(SLICE_BEFORE, { bubbles: true, detail: `${requestId}` }));
      try {
        nativeSet.call(this, value);
      } finally {
        document.dispatchEvent(new CustomEvent(SLICE_AFTER, { detail: `${requestId}` }));
      }
      return;
    }
    if (state.active) {
      const comparable = typeof value === 'string' ? value
        : value === null || (value === undefined && eventType === CHECK_TEXT) ? ''
          : value === undefined || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? `${value}`
            : undefined;
      if (comparable !== undefined) {
        if (!this.isConnected && checkDetached(this, eventType, comparable)) return;
        if (this.isConnected) {
          const event = new CustomEvent(eventType, { bubbles: true, cancelable: true, detail: comparable });
          if (!this.dispatchEvent(event)) return;
        }
      }
    }
    nativeSet.call(this, value);
  };
  Object.defineProperty(prototype, property, { ...descriptor, set: guardedSet });
  return () => {
    installed = false;
    if (Object.getOwnPropertyDescriptor(prototype, property)?.set === guardedSet) {
      Object.defineProperty(prototype, property, descriptor);
    } else {
      console.warn(`[LLM Page Translator] Cannot remove ${property} hook: accessor changed by the page`);
    }
  };
}

const key = Symbol.for('llm-page-translator:setter-guard');
const state = { active: false, experimentalSliceGuard: false };
if (!Reflect.has(window, key)) {
  let removeHooks: (() => void) | undefined;
  document.addEventListener(START, (event) => {
    if (!removeHooks) {
      const removeText = guardSetter(Node.prototype, 'textContent', CHECK_TEXT);
      try {
        const removeHtml = guardSetter(Element.prototype, 'innerHTML', CHECK_HTML);
        removeHooks = () => {
          removeHtml();
          removeText();
        };
      } catch (error) {
        removeText();
        throw error;
      }
    }
    const experimentalSliceGuard = event instanceof CustomEvent && event.detail === 'slice';
    try {
      configureSlice(experimentalSliceGuard);
    } catch (error) {
      removeHooks();
      removeHooks = undefined;
      throw error;
    }
    state.experimentalSliceGuard = experimentalSliceGuard;
    state.active = true;
    event.preventDefault();
  });
  document.addEventListener(STOP, () => {
    state.active = false;
    state.experimentalSliceGuard = false;
    configureSlice(false);
    removeHooks?.();
    removeHooks = undefined;
  });
  Object.defineProperty(window, key, { value: true });
}
