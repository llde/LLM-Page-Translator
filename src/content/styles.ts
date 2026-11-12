export const STYLE_ID = 'xt-style';

const CSS = `
@keyframes xt-rot { to { transform: rotate(360deg); } }
@keyframes xt-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.xt-seg.xt-busy {
  opacity: .65;
  background-image: linear-gradient(90deg, rgba(37,99,235,.05) 0%, rgba(37,99,235,.25) 50%, rgba(37,99,235,.05) 100%);
  background-size: 200% 100%;
  animation: xt-shimmer 1.4s linear infinite;
  border-radius: 2px;
}
.xt-seg.xt-spin::after {
  content: "";
  display: inline-block;
  box-sizing: border-box;
  width: .85em; height: .85em;
  margin-left: .3em;
  vertical-align: -.1em;
  border: 2px solid #2563eb;
  border-right-color: transparent;
  border-radius: 50%;
  animation: xt-rot .7s linear infinite;
}
.xt-seg.xt-error { outline: 2px dashed #dc2626; outline-offset: 1px; background: rgba(220,38,38,.08); border-radius: 2px; }
.xt-seg.xt-oversized { outline: 2px dashed #ea580c; outline-offset: 1px; background: rgba(234,88,12,.08); border-radius: 2px; }
.xt-badge-host { display: inline-block !important; vertical-align: middle; margin: 0 .25em; line-height: normal; }
@media (prefers-reduced-motion: reduce) {
  .xt-seg.xt-busy { animation: none; }
  .xt-seg.xt-spin::after { animation-duration: 2s; }
}
`;

export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

export function removeStyles(): void {
  document.getElementById(STYLE_ID)?.remove();
}

export const BADGE_CSS = `
:host { all: initial; display: inline-block; }
.b { font: 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111;
  background: #fff; border: 1px solid; border-radius: 6px; padding: 4px 6px; box-shadow: 0 2px 8px rgba(0,0,0,.18);
  max-width: 420px; text-align: left; white-space: normal; }
.b.error { border-color: #dc2626; background: #fef2f2; }
.b.oversized { border-color: #ea580c; background: #fff7ed; }
.row { display: flex; gap: 6px; align-items: flex-start; flex-wrap: wrap; }
.icon { font-weight: 700; }
.error .icon { color: #dc2626; }
.oversized .icon { color: #ea580c; }
.msg { flex: 1 1 200px; word-break: break-word; }
.title { font-weight: 600; }
button { font: inherit; cursor: pointer; border: 1px solid #9ca3af; background: #fff; color: #111; border-radius: 4px; padding: 1px 8px; }
button:hover { background: #f3f4f6; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; }
.actions { display: flex; gap: 4px; flex-wrap: wrap; }
pre { margin: 6px 0 0; padding: 6px; max-height: 240px; overflow: auto; background: #111827; color: #e5e7eb;
  border-radius: 4px; font: 11px/1.4 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
`;
