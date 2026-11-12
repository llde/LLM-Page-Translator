# Stable iframe memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse translated chunks in iframe documents after reload by removing volatile browser frame IDs from translation-memory identity.

**Architecture:** The background resolves each sender frame's URL ancestry from `webNavigation.getAllFrames`. Translation memory keys use that ancestry together with the existing page, settings, and source-text identity.

**Tech Stack:** TypeScript, WebExtension APIs, Vitest, Playwright.

**Spec:** [2026-11-12-iframe-translation-memory-design.md](../specs/2026-11-12-iframe-translation-memory-design.md)

## Global Constraints

- Keep top-level and embedded-frame entries separate.
- Keep nested frame paths distinct while making identity stable across reloads.
- Identical-URL sibling frames under the same parent may share entries.
- Preserve existing settings, source-text, page, retention, and clear-page behavior.

## Review Focus

- A different browser frame ID with the same ancestry must hit memory — test in `translationMemory.test.ts`.
- A different parent path with the same final frame URL must miss memory — test in `translationMemory.test.ts`.
- A top-level page and its embedded document must remain isolated — test in `translationMemory.test.ts`.
- Identical-URL siblings under the same parent may share — test in `translationMemory.test.ts`.
- A nested `about:srcdoc` frame must retain the full ancestry and reuse after reload — assert through the E2E reload regression in `tests/e2e/run.mjs`.
- If browser frame metadata lookup fails, translation must continue without memory — test in `backgroundTranslationMemory.test.ts`.

---

### Task 1: Make iframe cache identity reload-stable

**Files:**
- Modify: `src/shared/translationMemory.ts`
- Modify: `src/background/index.ts`
- Test: `tests/translationMemory.test.ts`
- Test: `tests/backgroundTranslationMemory.test.ts`
- Test: `tests/e2e/run.mjs`

**Interfaces:**
- `TranslationMemoryContext` replaces `frameId` and `frameUrl` with `frameUrlAncestry: string[]`.
- The background derives that ancestry for `port.sender.frameId` by following `parentFrameId` links in `browser.webNavigation.getAllFrames({ tabId })`; if sender or ancestry metadata is unavailable, skip memory for that request.

- [x] **Step 1: Write focused failing memory tests**

  Update the context helper and cover cache reuse when only `frameId` changes, isolation when the ancestry differs, top-level/frame isolation, and sharing for identical sibling paths. Add a background test proving a rejected frame-metadata lookup does not block translation.

- [x] **Step 2: Run the focused tests and verify the expected failure**

  Run: `npm test -- tests/translationMemory.test.ts tests/backgroundTranslationMemory.test.ts`
  Expected: FAIL because the memory context still uses `frameId`/`frameUrl` and the background fails the chunk when frame metadata lookup rejects.

- [x] **Step 3: Implement URL-ancestry identity**

  Build the sender's ancestry from browser frame metadata in `src/background/index.ts`; if lookup rejects, log only when Text scan diagnostics are enabled and continue without a memory context. Hash the normalized URL sequence in `translationMemory.ts` instead of including `frameId`.

- [x] **Step 4: Verify unit tests and the reload regression**

  Run: `npm test -- tests/translationMemory.test.ts tests/backgroundTranslationMemory.test.ts`
  Expected: PASS.

  Run: `npm run typecheck && npm run e2e`
  Expected: typecheck succeeds and the E2E checks report completed frame translation, translated nested `about:srcdoc` text, and no additional provider requests after reload.
