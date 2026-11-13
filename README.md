# LLM Page Translator

Browser extension (Firefox + Chromium, Manifest V3) that translates the visible text of web pages using an
LLM served by **Ollama**, **OpenWebUI** or any **OpenAI-compatible** API.

- **Frontend (content script)**: scans visible text in each matching frame independently, splits it into phrases, groups phrases into chunks
  (same DOM depth per chunk, except one-word phrases can batch across depths; never exceeding the max chunk size;
  chunks never cross frame boundaries and a phrase that does not fit starts a new chunk), shows a spinner on
  text being processed, replaces it with the translation, and shows error overlays with **Retry** / **Details**.
- **Backend (background script)**: builds the prompt (system prompt + tab prompt + target language) and calls
  the LLM. Each chunk is sent as one coherent phrase with inline `[n]` markers preserving references to its original
  text spans. The model must answer inside `<translated_text>…</translated_text>`, keeping each marker before its
  corresponding translation so results can be applied to the original spans. It is also instructed to correct
  missing spaces after punctuation according to target-language conventions.
- A phrase longer than the max chunk size is not sent: an orange overlay lets you **Send as one chunk**
  (raises the limit for that chunk only) or **Split** it (at `, ; :`, then at words).
- Text added to the page later (infinite scroll, SPA updates) is translated too (can be disabled).
- The optional **Keep numbers unchanged and use them as chunk separators** setting avoids sending numbers for translation and lets surrounding text reuse memory when numbers change. It also splits numbers inside words and may reduce translation context.
- While translating, repeated page-script `textContent` and `innerHTML` assignments matching the original content are ignored, preserving translations and existing nodes. Different text or markup is applied normally.
- The optional **Experimental: ignore textContent updates from string slices** setting applies sliced text but excludes its mutation from dynamic translation. It changes `String.prototype.slice()` to return objects while translating and can break page scripts, including string method calls, strict equality and empty-string checks. Wrapper detection uses constructor names, so similarly named page objects can be mistaken for wrappers. It is disabled by default.

## Build

```bash
npm install
npm run build            # dist/chrome and dist/firefox
npm run build:chrome     # or a single target
npm run watch:firefox    # rebuild on change
npm test                 # unit tests (vitest)
npm run typecheck
npm run e2e              # end-to-end test in Chromium with a mock Ollama (needs Playwright's Chromium,
                         # or set CHROMIUM_PATH to a Chromium binary)
```

The two manifests live in [`manifests/`](manifests): `chrome.json` (background `service_worker`) and
`firefox.json` (background `scripts`, `browser_specific_settings`, Firefox ≥ 140). The build copies the right
one to `dist/<target>/manifest.json`.

## Install (unpacked)

- **Chrome / Edge / Brave**: `chrome://extensions` → enable *Developer mode* → *Load unpacked* → `dist/chrome`.
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → `dist/firefox/manifest.json`.
  Firefox treats host permissions as opt-in for MV3: click **Grant access** in the popup or options page
  (or enable it in `about:addons` → extension → Permissions).

Reload open tabs after installing so the content script is injected.

## Configure

**Options page** (global; right-click the toolbar icon → *Options*, or ⚙ in the popup):

| Setting | Notes |
|---|---|
| Provider | Ollama → `{base}/api/chat`; OpenWebUI → `{base}/api/chat/completions`; OpenAI-compatible → `{base}[/v1]/chat/completions` |
| Base URL, API key | API key is sent as `Authorization: Bearer …` when set |
| Model | Listbox filled from the backend (Ollama `/api/tags`, OpenWebUI `/api/models`, OpenAI-compatible `/v1/models`); reloads when provider/URL/key change or with ↻. Shows `<no model>` when the backend is unreachable or returns no models. No model is preselected; translating without one fails with a "No model selected" overlay |
| Context window | Sent to Ollama as `num_ctx`; for all providers the request is rejected up front if estimated prompt + max tokens exceeds it |
| Max response tokens | `num_predict` (Ollama) / `max_tokens` |
| Temperature, Request timeout | |
| Max chunk size | In characters of page text |
| Parallel requests | How many chunks are translated simultaneously |
| System prompt | Output-format instructions are appended automatically |
| Default tab prompt | Initial value for each tab |
| Default target language | Selector with common languages |
| Always translate these sites | Hostnames translated automatically on load |
| Translate dynamic content | Watch the page for new text |

**Toolbar popup** (per tab): source language (default *Auto-detect*; set it when the page language is ambiguous,
e.g. Spanish vs Portuguese, so the model is told explicitly), target language (default: the global one),
tab prompt (context such as "medical paper, keep Latin terms"),
Choose the current path or any ancestor in *Save prompt for path* and save the tab prompt for that prefix and its subpages;
query strings and fragments are excluded.
matching rules persist across browser restarts, and the most specific matching path wins. A tab-specific prompt takes priority,
followed by a saved URL rule and then the global default tab prompt.
per-tab overrides for chunk size / model / temperature, *Translate page*, *Restore original*, *Retry failed*,
*Always translate this site*, live progress, and a per-tab *Text scan diagnostics* toggle. When enabled, text-node
accept/reject decisions, observer mutations (including added, removed, and changed nodes), chunk dispatch,
backend completion/failure, and DOM replacement (with short text previews)
are logged to the tab's DevTools console; backend request-stage events also appear in the extension service worker console.

## Ollama CORS

Ollama rejects requests coming from unknown origins (HTTP 403). Allow extension origins, e.g.:

```bash
OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve
```

## Project layout

```
src/shared/      types, settings storage, phrase splitting, chunker, browser detection (isFirefox)
src/background/  port handling + LLM calls (providers.ts, prompt.ts)
src/content/     page scanning, wrapping, queue, spinner/overlay UI
src/popup/       per-tab settings
src/options/     global settings
tests/           unit tests; tests/e2e/run.mjs end-to-end smoke test
```

## Notes

- Translations are inserted with `textContent` only: model output is never interpreted as HTML.
- Elements with `translate="no"` or class `notranslate`, `<code>`, `<pre>`, editable or hidden content are skipped.
- Text in matching iframes is translated in a separate context from the parent and other frames. Cross-origin frames are included when the browser grants the extension host access; restricted or non-matching frames cannot be injected into.
- Unnamed, enabled `text`, `search`, `url`, `tel`, `email`, and `submit` inputs inside forms are translated when they have a `value` attribute and a non-empty current value. The displayed value is restored when translation is stopped, unless it was edited in the meantime.
- Hovering over translated text shows the original phrase.
