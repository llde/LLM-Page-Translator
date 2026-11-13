const CHECK_TEXT = 'llm-page-translator:check-text-content';
const CHECK_HTML = 'llm-page-translator:check-inner-html';
const START = 'llm-page-translator:setter-guard-start';
const STOP = 'llm-page-translator:setter-guard-stop';
const DETACHED_TEXT = 'llm-page-translator:detached-text';
const DETACHED_HTML = 'llm-page-translator:detached-html';
const DETACHED_TARGET = 'llm-page-translator:detached-target';
const DETACHED_CLEANUP = 'llm-page-translator:detached-cleanup';

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

function guardSetter(prototype: object, property: string, eventType: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
  if (!descriptor?.set || !descriptor.get) throw new Error(`Cannot guard ${property}: missing native accessor`);
  const nativeSet = descriptor.set;
  Object.defineProperty(prototype, property, {
    ...descriptor,
    set(this: Node, value: unknown) {
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
    },
  });
}

const key = Symbol.for('llm-page-translator:setter-guard');
const state = { active: false };
if (!Reflect.has(window, key)) {
  guardSetter(Node.prototype, 'textContent', CHECK_TEXT);
  guardSetter(Element.prototype, 'innerHTML', CHECK_HTML);
  document.addEventListener(START, (event) => {
    state.active = true;
    event.preventDefault();
  });
  document.addEventListener(STOP, () => { state.active = false; });
  Object.defineProperty(window, key, { value: true });
}
