# MutationObserver Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compact MutationObserver callback summaries controlled by the existing per-tab Text scan diagnostics setting.

**Architecture:** Keep diagnostics in the content script's existing observer callback and use `logTextDiagnostic`. Summarize each callback's record counts and debounce action without exposing page URLs, text, or DOM node details.

**Tech Stack:** TypeScript, Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-11-12-mutation-observer-diagnostics-design.md`

## Global Constraints

- Gate every observer diagnostic with the existing per-tab Text scan diagnostics setting.
- Report ignored-only callbacks as well as callbacks with relevant mutations.
- Do not log page URLs, text, node names, IDs, or other DOM content.
- Preserve the current relevance filtering, debounce timing, scan behavior, and observer lifecycle.

## Review Focus

- **Diagnostics disabled:** observer callbacks in the diagnostics-disabled iframe must produce no observer logs; assert in the E2E test.
- **Irrelevant-only callback:** report ignored records without changing debounce behavior; remove a probe node and assert zero relevant records and an unchanged debounce action.
- **Debounce transitions:** the first relevant callback schedules and a second within the debounce interval restarts the scan timer; assert both actions in E2E.
- **Privacy:** summaries must not contain a known page URL, source phrase, or node details; assert against captured observer logs.
- **Mutation-type counts:** child-list records must be counted; assert the count field for the probe mutations.

---

### Task 1: Add gated observer summaries

**Files:**
- Modify: `src/content/index.ts`
- Modify: `src/content/diagnostics.ts`
- Test: `tests/contentDiagnostics.test.ts`
- Test: `tests/e2e/run.mjs`

**Interfaces:**
- Consumes: `logTextDiagnostic(event: string, detail: unknown)` and `cfg?.textDiagnostics`.
- Produces: `analyzeMutationBatch<T>(records: readonly T[], isRelevant: (record: T) => boolean, includeRelevantRecords: boolean): { hasRelevantRecords: boolean; relevantRecords?: T[] }`, which short-circuits when record details are not requested.
- Produces: a `mutation observer` diagnostic event with `recordCount`, `relevantRecordCount`, `ignoredRecordCount`, `childListRecords`, `characterDataRecords`, and `debounceAction` (`'unchanged' | 'scheduled' | 'restarted'`).

- [x] **Step 1: Write failing E2E assertions** that create two relevant DOM mutations within the debounce period, then remove a probe node. Assert callback summaries include child-list counts, scheduled/restarted actions, and an ignored-only callback with unchanged debounce; assert disabled iframe diagnostics emit no observer summary and summaries contain no URL, text, or node details.
- [x] **Step 2: Run `npm run build:chrome && npm run e2e`** and confirm the new observer-summary assertions fail because no MutationObserver diagnostics exist yet.
- [x] **Step 3: Implement `analyzeMutationBatch` in `src/content/diagnostics.ts` with a short-circuit `some` path when details are not requested and a full `filter` path when summaries are enabled. Use it in `startObserver` in `src/content/index.ts` to log each summary only when relevant records are returned. Set the debounce handle to `null` when its timer fires so later callbacks distinguish scheduling from restarting; preserve the existing scan timing and relevance behavior.**
- [x] **Step 4: Run `npm run build:chrome && npm run e2e`** and confirm the observer-summary, debounce, privacy, and disabled-setting assertions pass.
- [x] **Step 5: Run `npm test`, `npm run typecheck`, and `npm run build`** to verify the complete change.
