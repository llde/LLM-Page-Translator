# Memory preflight concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply cached translations without consuming a “Parallel requests” slot; use that limit only for requests sent to the LLM.

**Architecture:** Add a memory-preflight request/response to the existing content/background port. The content script checks all eligible chunks independently, applies hits immediately, and sends misses through the existing viewport-prioritized concurrency queue. The background's translate path performs provider work and stores successful translations without repeating the cache lookup.

**Tech Stack:** TypeScript, WebExtension ports/storage, Vitest, Playwright.

**Spec:** [2026-11-13-memory-preflight-design.md](../specs/2026-11-13-memory-preflight-design.md)

## Global Constraints

- The “Parallel requests” limit controls only requests sent to the LLM.
- Cached translations are applied independently of provider concurrency.
- Preserve existing chunk ordering/viewport priority and queued/busy status behavior for provider work.
- A frame-ancestry lookup failure acts as a cache miss; a failure to read stored memory remains an explicit error.
- Do not change the configured concurrency limit or how many provider requests it permits.

## Review Focus

- Several cache checks can proceed while concurrency is one — prove with the E2E pending-provider scenario in `tests/e2e/run.mjs`.
- A later cached chunk applies while an earlier miss occupies the only provider slot — assert in the same E2E scenario.
- A cache miss waits for the provider slot and does not exceed the configured concurrency — assert provider request overlap in the same E2E scenario.
- Missing frame ancestry proceeds as a cache miss and reaches provider translation — test in `tests/backgroundTranslationMemory.test.ts`.
- Cache storage read errors remain visible instead of becoming successful-shaped misses — test in `tests/backgroundTranslationMemory.test.ts`.

---

### Task 1: Separate memory preflight from provider dispatch

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/content/index.ts`
- Modify: `src/background/index.ts`
- Test: `tests/backgroundTranslationMemory.test.ts`
- Test: `tests/e2e/run.mjs`

**Interfaces:**
- `PortIn` adds `{ type: 'checkMemory'; chunkId: number; segments: SegmentPayload[] }`.
- `PortOut` adds `memoryHit` with `translations` and `memoryMiss` without them; existing `result`/`error` responses remain for provider work.
- Content marks chunks as checking during preflight; hits complete directly, misses enter the existing queue and are counted against `ContentConfig.concurrency` only when dispatched as `translate`.

- [ ] **Step 1: Write failing preflight/concurrency tests**

  Add background tests for memory-hit and missing-ancestry responses, plus storage-read failure propagation. Add an E2E case with concurrency set to one, an uncached delayed chunk occupying the provider slot, and later cached chunks that must be applied before that request completes.

- [ ] **Step 2: Run focused tests and verify the expected failure**

  Run: `npm test -- tests/backgroundTranslationMemory.test.ts`
  Expected: FAIL because the background does not recognize the preflight message. Run the E2E test and verify cached chunks remain queued behind the uncached provider request.

- [ ] **Step 3: Implement the preflight protocol and provider-only queue**

  In `src/shared/types.ts`, add the typed preflight messages. In `src/background/index.ts`, handle cache checks separately, returning hits/misses and preserving explicit storage errors; keep successful-result storage in the provider path without a second lookup. In `src/content/index.ts`, check memory when chunks are enqueued, apply hits directly, and send misses to the existing concurrency-limited `pump()`.

- [ ] **Step 4: Verify focused tests and the full suite**

  Run: `npm test -- tests/backgroundTranslationMemory.test.ts`
  Expected: PASS.

  Run: `npm test && npm run typecheck && npm run e2e`
  Expected: all unit tests, typecheck, and E2E checks pass; the concurrency-one E2E case observes cached application during the delayed LLM request and no provider concurrency above one.
