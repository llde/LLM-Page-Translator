# LLM Page Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Firefox + Chromium MV3 extension that translates visible page text in phrase-aligned chunks via Ollama / OpenWebUI / OpenAI-compatible LLMs.

**Architecture:** The content script (frontend) scans the page, splits it into phrases, chunks them, queues them, and renders the page UI. The background script (backend) receives chunks over a `runtime.Port`, builds prompts, calls the LLM, and parses `<translated_text>`. The popup holds per-tab settings and the options page holds global settings.

**Tech Stack:** TypeScript 5, esbuild, webextension-polyfill, vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-translation-extension-design.md`

## Global Constraints
- Manifest V3 for both browsers; `manifests/chrome.json` uses `background.service_worker`, `manifests/firefox.json` uses `background.scripts` + `browser_specific_settings.gecko` (strict_min_version 140.0).
- Chunk size measured in characters of trimmed segment text (markers excluded).
- Translations written to the DOM via `textContent` only (never `innerHTML`).
- LLM output must be enclosed in `<translated_text>…</translated_text>` and keep `[n]` markers.
- Browser-specific runtime code gated behind `isFirefox()` from `src/shared/browser.ts`.

## File Structure
```
package.json, tsconfig.json, build.mjs, README.md
manifests/chrome.json, manifests/firefox.json
src/shared/browser.ts      isFirefox(), re-export polyfill
src/shared/types.ts        shared types + message protocol
src/shared/settings.ts     defaults, load/save global & tab settings, effective config
src/shared/phrases.ts      splitPhrases(), splitOversized()
src/shared/chunker.ts      buildChunks()
src/background/prompt.ts   buildMessages(), parseResponse()
src/background/providers.ts buildRequest(), extractContent(), estimateTokens(), checkBudget()
src/background/index.ts    port handling, fetch, abort, config/test messages
src/content/styles.ts      injected CSS
src/content/dom.ts         scanTextNodes(), wrapTextNode(), restore helpers
src/content/badge.ts       shadow-DOM error/oversized badge
src/content/index.ts       controller: state, queue, port, observer, popup messages
src/popup/popup.html|css|ts
src/options/options.html|ts
tests/*.test.ts
```

---

### Task 1: Scaffolding & build
**Files:** Create `package.json`, `tsconfig.json`, `build.mjs`, `manifests/*.json`, `src/shared/browser.ts`, `src/shared/types.ts`.
**Produces:** `npm run build:chrome|build:firefox|build|test|typecheck`; `isFirefox(): boolean`; types `Provider`, `GlobalSettings`, `TabSettings`, `SegmentPayload {id:number,text:string}`, `ErrorInfo {message:string,status?:number,details:string}`, port messages `PortIn = {type:'translate',chunkId:number,segments:SegmentPayload[]} | {type:'cancel',chunkId:number} | {type:'ping'}`, `PortOut = {type:'result',chunkId:number,translations:Record<number,string>} | {type:'error',chunkId:number,error:ErrorInfo}`.
- [ ] `build.mjs <chrome|firefox>` bundles `background/index.ts`, `content/index.ts`, `popup/popup.ts`, `options/options.ts` (IIFE, es2020) into `dist/<target>/`, copies html/css and `manifests/<target>.json` → `manifest.json`.
- [ ] `npm install`, `npm run build` produces both dists.

### Task 2: Phrase splitting (TDD)
**Files:** `src/shared/phrases.ts`, `tests/phrases.test.ts`
**Produces:** `splitPhrases(text:string):string[]` (concatenation === input, whitespace-only pieces merged into previous); `splitOversized(text:string,max:number):string[]` (each piece trimmed length ≤ max, concat === input; split order: after `, ; :` → words → hard cut).
- [ ] Tests:
```ts
expect(splitPhrases('Hello world. How are you? Fine.')).toEqual(['Hello world. ','How are you? ','Fine.']);
expect(splitPhrases('  ').join('')).toBe('  ');
const s = 'alpha beta, gamma delta; epsilon zeta: eta theta';
const parts = splitOversized(s, 20);
expect(parts.join('')).toBe(s);
parts.forEach(p => expect(p.trim().length).toBeLessThanOrEqual(20));
expect(splitOversized('a'.repeat(25), 10).join('')).toBe('a'.repeat(25));
```
- [ ] Implement, run `npx vitest run tests/phrases.test.ts` → PASS.

### Task 3: Chunker (TDD)
**Files:** `src/shared/chunker.ts`, `tests/chunker.test.ts`
**Produces:** `interface ChunkPlan {segmentIds:number[]; size:number; oversized:boolean}`; `buildChunks(segs:SegmentPayload[], max:number):ChunkPlan[]`.
- [ ] Tests:
```ts
const segs = [{id:1,text:'a'.repeat(200)},{id:2,text:'b'.repeat(300)},{id:3,text:'c'.repeat(100)}];
expect(buildChunks(segs,512).map(c=>c.segmentIds)).toEqual([[1,2],[3]]);
expect(buildChunks([{id:1,text:'x'.repeat(600)},{id:2,text:'y'}],512))
  .toEqual([{segmentIds:[1],size:600,oversized:true},{segmentIds:[2],size:1,oversized:false}]);
expect(buildChunks([{id:1,text:'a'.repeat(512)}],512)[0].oversized).toBe(false);
```
- [ ] Implement, run → PASS.

### Task 4: Prompt + parser (TDD)
**Files:** `src/background/prompt.ts`, `tests/prompt.test.ts`
**Produces:** `FORMAT_INSTRUCTIONS:string`; `buildMessages(p:{systemPrompt:string;tabPrompt:string;targetLanguage:string}, segs:SegmentPayload[]):ChatMessage[]`; `parseResponse(raw:string, ids:number[]):Record<number,string>` throwing `ParseError` (message + details).
- [ ] Tests: system message contains `<translated_text>`; user message contains `[1] Hello` and tab prompt; parse `'<think>x</think><translated_text>\n[1] Ciao\n[2] Mondo\n</translated_text>'` → `{1:'Ciao',2:'Mondo'}`; inline `[1] Ciao [2] Mondo` works; missing id throws; no tag throws; single id without marker returns full text.
- [ ] Implement, run → PASS.

### Task 5: Providers (TDD)
**Files:** `src/background/providers.ts`, `tests/providers.test.ts`
**Produces:** `interface LlmConfig {provider:Provider; baseUrl:string; apiKey:string; model:string; contextWindow:number; maxTokens:number; temperature:number}`; `buildRequest(cfg, msgs):{url:string; headers:Record<string,string>; body:unknown}`; `extractContent(provider, json):{content:string; truncated:boolean}`; `estimateTokens(msgs):number`; `checkBudget(cfg,msgs):void` (throws `BudgetError`).
- [ ] Tests: ollama → `http://h:11434/api/chat`, body `options.num_ctx/num_predict/temperature`, `stream:false`; openai with base `…/v1` → `…/v1/chat/completions`, `max_tokens`, Bearer header only when key set; openwebui → `/api/chat/completions`; extract both shapes; `finish_reason:'length'` → truncated; budget throws when estimate+maxTokens > contextWindow.
- [ ] Implement, run → PASS.

### Task 6: Settings + background
**Files:** `src/shared/settings.ts`, `src/background/index.ts`
**Produces:** `DEFAULT_SETTINGS`, `loadGlobal()`, `saveGlobal(p)`, `loadTab(tabId)`, `saveTab(tabId,s)`, `clearTab(tabId)`, `effectiveConfig(g,t)`; runtime messages `{type:'getConfig'}` → `{maxChunkSize,concurrency,translateDynamic,autoTranslate}`, `{type:'testConnection', settings?}` → `{ok, message, details?}`.
- [ ] Tab storage: `storage.session` when available, else `storage.local` key `tab:<id>` (gated) and cleared on `tabs.onRemoved`.
- [ ] Port `xt`: translate → budget check → fetch (AbortController, timeout `requestTimeoutSec`) → parse → `result`/`error` with details (status, provider, model, url, body/raw). Network failure message mentions CORS/`OLLAMA_ORIGINS`.
- [ ] `npm run typecheck` passes.

### Task 7: Content script
**Files:** `src/content/styles.ts`, `dom.ts`, `badge.ts`, `index.ts`
- [ ] `scanTextNodes(root)` skips excluded tags, invisible elements, our nodes; `wrapTextNode(node)` → `span.xt-node` containing `span.xt-seg` per phrase, original text kept in a WeakMap.
- [ ] Controller: start (scan → segments → `buildChunks` → queue with `concurrency`), busy classes + spinner, result replace (keep lead/trail whitespace), error badge (Retry, Details), oversized badge (Send anyway, Split), restore, status, retryErrors, MutationObserver (debounced 600 ms, ignores own nodes), keepalive ping every 20 s while busy, port disconnect → in-flight chunks become retryable errors.
- [ ] Auto-translate on load when `getConfig().autoTranslate`.

### Task 8: Popup + options + README
- [ ] Popup: tab prompt, target language, chunk size/model/temperature overrides (saved per tab), Translate/Restore/Retry failed, auto-translate-site toggle, live status, link to options.
- [ ] Options: all global fields + Save + Test connection.
- [ ] README: build, load in Chrome/Firefox, Ollama CORS note.
- [ ] `npm test`, `npm run typecheck`, `npm run build` all succeed; both `dist/*/manifest.json` present.
