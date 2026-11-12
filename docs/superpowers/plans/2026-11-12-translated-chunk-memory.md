# Translated Chunk Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse successful translations from persistent, page-scoped memory, isolate iframe entries, expire inactive pages, and let users clear the current page’s memory.

**Architecture:** Add a storage-backed helper in `src/shared/translationMemory.ts` keyed by normalized page URL, frame identity, chunk text, and translation-affecting settings. The background checks and writes this memory around its existing provider call; page activity drives expiry, and a popup action clears all entries for the active page.

**Tech Stack:** TypeScript, webextension-polyfill storage/runtime APIs, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-translated-chunk-memory-design.md`

## Global Constraints

- Persist cached translations across browser and background restarts.
- Reuse a translation only when both the chunk text and translation-affecting settings match.
- Isolate the top document from each embedded frame.
- Provide a popup action that clears the current page's top-document and iframe memories.
- Expire a page's memory after a configurable number of inactive days, default 30 days.
- Keep existing translation behavior for cache misses and never cache failures.

## Review Focus

- **Identical text under a different prompt, language, or provider must miss the cache.** Test that the request identity changes for translation-affecting settings.
- **Identical text in a different frame must not hit another frame's entry.** Test top-frame and iframe namespace separation.
- **Expired pages must lose all frame entries without deleting a recently visited page.** Test expiry using controlled timestamps.
- **A provider error must not be stored as a successful result.** Test failure path by ensuring storage writes happen only after a successful translation.
- **Clearing one page must not clear other pages.** Test page-scoped clearing across all of that page's frame entries.

---

### Task 1: Add configurable memory retention

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/settings.ts`
- Modify: `src/options/options.html`
- Modify: `src/options/options.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces `GlobalSettings.memoryRetentionDays: number`, defaulting to `30`.
- Invalid or missing stored values normalize to the default; the options form uses a required number input with `min="1"` and `step="1"`.

- [x] **Step 1: Write failing settings tests** for the 30-day default, preserving a valid configured value, and normalizing a missing or invalid value to 30.
- [x] **Step 2: Run `npm test -- tests/settings.test.ts`** and confirm the new normalization assertions fail.
- [x] **Step 3: Add and normalize `memoryRetentionDays`** in shared settings; add a required positive-integer retention input to global options and read/save it with the other numeric settings.
- [x] **Step 4: Run `npm test -- tests/settings.test.ts`** and confirm the assertions pass.

### Task 2: Implement persistent page/frame translation memory

**Files:**
- Create: `src/shared/translationMemory.ts`
- Test: `tests/translationMemory.test.ts`

**Interfaces:**
- `TranslationMemoryContext` contains the normalized top-level `pageUrl`, `frameId`, and current `frameUrl`.
- `getTranslationMemory(context: TranslationMemoryContext, settings: EffectiveSettings, segments: readonly SegmentPayload[]): Promise<Record<number, string> | undefined>` returns a hit mapped to current segment IDs.
- `setTranslationMemory(context: TranslationMemoryContext, settings: EffectiveSettings, segments: readonly SegmentPayload[], translations: Record<number, string>): Promise<void>` stores a successful chunk result.
- `visitTranslationMemory(pageUrl: string, retentionDays: number): Promise<void>` refreshes page activity and removes entries for pages past the configured inactivity period.
- `clearPageTranslationMemory(pageUrl: string): Promise<void>` removes all entries for that page, across every frame.
- Cache identity is deterministic and includes ordered source text and translation-affecting settings; credentials are not stored in cache keys or values.

- [x] **Step 1: Write failing helper tests** for repeat-hit ID remapping, frame and settings isolation, expiry of all stale frame entries while preserving a recently visited page, and page-only clearing.
- [x] **Step 2: Run `npm test -- tests/translationMemory.test.ts`** and confirm the new tests fail.
- [x] **Step 3: Implement the storage-backed helper** using `browser.storage.local`; store only successful result values and page activity metadata.
- [x] **Step 4: Run `npm test -- tests/translationMemory.test.ts`** and confirm the helper tests pass.

### Task 3: Use memory in the background and expose page clearing

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/background/index.ts`
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.ts`
- Modify: `tests/e2e/run.mjs`

**Interfaces:**
- Extend `RuntimeRequest` with `{ type: 'clearPageMemory'; pageUrl: string }`.
- Page activity is recorded when the background receives the content-script `getConfig` request, using the configured retention days and top-level tab URL.
- On the existing translation port, look up memory before calling `translate`; after a successful provider response, store it before returning it to the content script.
- The popup's **Clear page memory** button sends the clear request for its current tab URL and reports success or failure in the existing status area.

- [x] **Step 1: Extend the Playwright smoke test** to assert a repeated translation produces no additional provider request, distinct top/frame entries remain isolated, a failed request is retried at the provider, and clearing the page forces the next translation to call the provider again; assert the popup control and options retention field are present.
- [x] **Step 2: Run `npm run build:chrome && npm run e2e`** and verify the new checks fail before integration.
- [x] **Step 3: Integrate page activity, cache lookup/write, clear-message handling, popup control, and explicit popup error reporting.** Keep `testConnection` on its existing uncached path.
- [x] **Step 4: Run `npm run build:chrome && npm run e2e`** and verify all smoke checks pass.
- [x] **Step 5: Run `npm test`, `npm run typecheck`, and `npm run build`** to verify the complete change and both browser targets.
