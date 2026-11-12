# LLM Page Translator — Browser Extension Design

## Goal
A Firefox + Chromium (Manifest V3) extension that translates the visible text of a web page using an
LLM served by Ollama, OpenWebUI, or any OpenAI-compatible API.

## Architecture
- **Language/tooling:** TypeScript, bundled with esbuild. `npm run build:chrome` → `dist/chrome`,
  `npm run build:firefox` → `dist/firefox`. Unit tests with vitest.
- **Manifests:** `manifests/chrome.json` (background `service_worker`) and `manifests/firefox.json`
  (background `scripts`, `browser_specific_settings.gecko`, Firefox ≥ 140). Browser-specific runtime code is gated
  via `isFirefox()` in `src/shared/browser.ts`.
- **Frontend = content script** (`src/content/`): scan, phrase segmentation, chunking, request queue,
  spinner/overlay UI, restore, MutationObserver for dynamic content.
- **Backend = background script** (`src/background/`): owns a `runtime.Port` per tab, builds prompts,
  calls the LLM provider, supports abort per chunk.
- **Popup** (`src/popup/`): per-tab settings and actions.
- **Options page** (`src/options/`): global settings.

## Text extraction & mapping (approach A)
1. Walk visible text nodes with a `TreeWalker` (skip `script, style, noscript, textarea, input,
   select, code, pre, svg, [contenteditable]`, hidden elements, whitespace-only nodes, and the
   extension's own UI).
2. Split each text node into phrases with `Intl.Segmenter(granularity: "sentence")` (regex fallback).
   Each phrase is wrapped in `<span class="xt-seg" data-xt-id="n">`, replacing the original text node.
   Original text is retained in memory for restore.
3. A chunk is an ordered list of segments sent as numbered lines `[id] text`. The model must return
   `<translated_text>` containing the same `[id]` markers; translations are written back per segment
   via `textContent` (never HTML).

## Chunking
- Size is measured in characters of segment text (markers excluded).
- Phrases are appended in reading order; if appending the next phrase would exceed `maxChunkSize`,
  the current chunk is closed and the phrase starts a new chunk.
- A phrase longer than `maxChunkSize` on its own becomes an **oversized** chunk, which is not sent.
  It is marked in the page with an overlay giving two choices:
  - **Send anyway**: send it as a single chunk (the limit is raised for this chunk only).
  - **Split**: split it at `, ; :` boundaries, then at word boundaries, then hard-cut as a last
    resort. Each piece becomes its own segment, and the pieces are re-chunked.

## Prompting
- System message = user system prompt + fixed format instructions: output only
  `<translated_text>…</translated_text>`, preserve each `[n]` marker on its own line, no commentary.
- User message = tab prompt (context) + target language + numbered segments.
- Parsing: extract the last `<translated_text>` block; parse `[n]` lines (multi-line content allowed).
  Missing ids → error "format mismatch" for the chunk (with raw response in details).

## Providers
| Provider | Endpoint | Notes |
|---|---|---|
| Ollama | `{base}/api/chat` | `stream:false`, `options.num_ctx`, `options.num_predict`, `options.temperature` |
| OpenAI-compatible | `{base}/v1/chat/completions` | `max_tokens`, `temperature`, Bearer key optional |
| OpenWebUI | `{base}/api/chat/completions` | Bearer key, OpenAI-style body |

The context window is checked before sending: estimated prompt tokens (chars/3) + `maxTokens` must be
≤ `contextWindow`. If it does not fit, the request fails with a "context window exceeded" error.

Model selection is a listbox populated by the background from the provider's list endpoint
(Ollama `GET /api/tags`, OpenWebUI `GET /api/models`, OpenAI-compatible `GET [/v1]/models`). When the backend is
unreachable or returns no models, the list shows `<no model>`; a saved model missing from the list is kept and
labelled "(not available)". Saving with no model is allowed but shows a warning. The popup's per-tab model
override uses the same list, with a leading "(global: …)" entry.

## Page UI states
- **pending/processing:** segments get class `xt-busy` (faded and shimmering); the last segment of the chunk shows a spinning
  icon via `::after`.
- **done:** text replaced; class `xt-done`.
- **error:** segments outlined red (`xt-error`); an inline shadow-DOM badge after the chunk shows the
  short error message, **Retry**, and **Details** (expandable: HTTP status, provider, model, URL,
  response body/raw output).
- **oversized:** orange outline + badge with **Send anyway** / **Split**.
- **Restore:** aborts in-flight requests, removes the badges, and restores the original text nodes.

## Settings
**Global (options page, `storage.local`):** provider, baseUrl, apiKey, model, contextWindow,
maxTokens, temperature, maxChunkSize, concurrency, systemPrompt, defaultTabPrompt, targetLanguage
default, autoTranslateSites (hostnames), translateDynamic (bool).

**Per tab (popup, `storage.session` keyed by tabId, fallback in-memory):** tabPrompt, sourceLanguage (selector,
default "Auto-detect" = omitted from the prompt; when set the prompt states "Source language: X" and tells the model
to treat all segments as that language), targetLanguage (selector, default = global), maxChunkSize override, model override,
temperature override. Language selectors use a shared list of common languages (`src/shared/languages.ts`);
a stored value missing from the list is kept as "(custom)". Actions: Translate, Restore,
"Auto-translate this site" toggle, progress counters (done/error/pending).

## Dynamic content
When translation is active, a debounced MutationObserver scans the added nodes or changed text and queues new chunks.
Mutations caused by the extension itself are ignored.

## Auto-translate
On load, the content script asks the background whether the hostname is in `autoTranslateSites`;
if so it starts translation using defaults.

## Testing
Unit tests: phrase splitting, chunker (boundary, oversized, split), response parser, provider request
builders, token budget. Manual: load the unpacked extension in each browser (README).
