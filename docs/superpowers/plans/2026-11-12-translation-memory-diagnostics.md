# Translation Memory Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in memory lifecycle diagnostics controlled by the existing per-tab Text scan diagnostics setting.

**Architecture:** Keep memory diagnostics in the background, where lookup, storage, expiry, and clear operations already occur. Have memory cleanup helpers return counts, pass the active tab ID with popup clear requests, and emit only counts and identifiers when that tab's diagnostic setting is enabled.

**Tech Stack:** TypeScript, webextension-polyfill, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-translation-memory-diagnostics-design.md`

## Global Constraints

- Log memory hits, misses, successful stores, expired entries, and page clears only when the relevant tab has text diagnostics enabled.
- Include useful chunk/frame identifiers and counts, but never log page URLs, source text, or translations.
- Keep diagnostics in the background where memory operations already occur.
- No new settings or controls.
- No changes to cache identity, retention, or translation results.

## Review Focus

- **Diagnostics disabled:** cache hits, misses, stores, expiry, and clear must not log when the tab setting is false. Test with the iframe page's default diagnostics-disabled setting.
- **Diagnostics enabled:** hits, misses, and successful stores are observable without logging page URLs or chunk text. Assert event labels and absence of known URL/text in captured logs.
- **Expiry counts:** expired page and chunk counts must reflect actual removed data. Assert with the existing controlled-time storage tests.
- **Clear diagnostics:** the popup's tab ID selects that tab's setting; clear logging reports actual removed chunks only when enabled. Assert in the browser smoke test.
- **Provider errors:** a failed provider request must not emit a successful memory-store event. Assert alongside the existing failed-chunk retry test.

---

### Task 1: Add memory lifecycle diagnostics

**Files:**
- Modify: `src/shared/translationMemory.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/background/index.ts`
- Modify: `src/popup/popup.ts`
- Modify: `tests/translationMemory.test.ts`
- Modify: `tests/e2e/run.mjs`

**Interfaces:**
- `visitTranslationMemory(pageUrl: string, retentionDays: number): Promise<{ expiredPages: number; expiredEntries: number }>`
- `clearPageTranslationMemory(pageUrl: string): Promise<{ removedEntries: number }>`
- Extend `RuntimeRequest` clear-message shape to `{ type: 'clearPageMemory'; pageUrl: string; tabId: number }`.
- The popup supplies its active `tabId`; the background reads that tab's effective settings before logging the clear result.

- [x] **Step 1: Write failing tests** for the cleanup/clear counts, enabled hit/miss/store/expiry/clear event coverage, disabled logging, no page URL/text leakage, and no store event after provider failure.
- [x] **Step 2: Run `npm test -- tests/translationMemory.test.ts` and `npm run build:chrome && npm run e2e`**; confirm the new behavioral assertions fail before implementation.
- [x] **Step 3: Return exact removal counts from memory cleanup and page clear; pass `tabId` in the popup request; log hit, miss, store, expiry, and clear events only under the existing tab diagnostic flag.** Keep event details to IDs/counts and do not include URLs or text.
- [x] **Step 4: Run `npm test -- tests/translationMemory.test.ts` and `npm run build:chrome && npm run e2e`**; confirm the diagnostic assertions pass.
- [x] **Step 5: Run `npm test`, `npm run typecheck`, and `npm run build`** to verify the complete change and both browser targets.
