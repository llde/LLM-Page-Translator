import { BADGE_CLASS } from './dom';
import { BADGE_CSS } from './styles';

export interface BadgeAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}

export interface BadgeOptions {
  kind: 'error' | 'oversized';
  title: string;
  message: string;
  details?: string;
  actions: BadgeAction[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Inline badge rendered in a shadow root so page CSS cannot affect it. */
export function createBadge(opts: BadgeOptions): HTMLElement {
  const host = el('span', BADGE_CLASS);
  host.setAttribute('translate', 'no');
  const root = host.attachShadow({ mode: 'open' });
  const style = el('style');
  style.textContent = BADGE_CSS;

  const box = el('div', `b ${opts.kind}`);
  box.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status');
  const row = el('div', 'row');
  row.append(el('span', 'icon', opts.kind === 'error' ? '⚠' : '⇲'));
  const msg = el('div', 'msg');
  msg.append(el('div', 'title', opts.title), el('div', undefined, opts.message));
  row.append(msg);

  const actions = el('div', 'actions');
  for (const a of opts.actions) {
    const b = el('button', a.primary ? 'primary' : undefined, a.label);
    if (a.title) b.title = a.title;
    b.addEventListener('click', () => a.onClick());
    actions.append(b);
  }

  let pre: HTMLPreElement | null = null;
  if (opts.details) {
    const btn = el('button', undefined, 'Details');
    btn.addEventListener('click', () => {
      if (pre) {
        pre.remove();
        pre = null;
        btn.textContent = 'Details';
        return;
      }
      pre = el('pre', undefined, opts.details);
      box.append(pre);
      btn.textContent = 'Hide details';
    });
    const copy = el('button', undefined, 'Copy');
    copy.title = 'Copy error details to clipboard';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(`${opts.message}\n\n${opts.details}`).then(
        () => (copy.textContent = 'Copied'),
        () => (copy.textContent = 'Copy failed'),
      );
    });
    actions.append(btn, copy);
  }
  row.append(actions);
  box.append(row);
  root.append(style, box);

  // The badge may sit inside a link/button of the page: never let clicks reach the page.
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
    host.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === 'click') e.preventDefault();
    });
  }
  return host;
}
