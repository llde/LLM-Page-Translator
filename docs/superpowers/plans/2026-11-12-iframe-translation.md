# Iframe Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate text in each injectable iframe using an independent frame-local scan, chunk queue, and lifecycle.

**Architecture:** Inject the existing content script into matching frames, including eligible blank child frames. Use `webNavigation.getAllFrames` and frame-targeted `tabs.sendMessage` calls from the popup; combine responses into one tab status while each content script retains independent state.

**Tech Stack:** TypeScript, WebExtension APIs (Chrome MV3 and Firefox MV3), esbuild, Vitest, Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-11-12-iframe-translation-design.md`

## Global Constraints

- Do not bypass browser origin, host-permission, restricted-page, or frame sandbox restrictions.
- Do not change phrase splitting, translation prompts, or chunk limits within a frame.
- Keep Chrome and Firefox support and use the extension's existing browser APIs and content-script pipeline.
- Chunks must never combine text from different frames.

## Review Focus

- Cross-origin frame with host access: its text is translated in its own requests. **Test:** E2E asserts an external-frame phrase is sent and translated separately from the top-frame phrase.
- Frame without a responding content script: its failure must not discard statuses from other frames. **Test:** E2E broadcast aggregation retains responding frame statuses when a frame-targeted message rejects.
- Eligible `about:blank`/`srcdoc` frame: injection follows the matching parent document. **Test:** E2E asserts text in a blank child frame is translated.
- Nested frames: every injectable document gets a separate translation context. **Test:** E2E asserts nested-frame text is translated without appearing in another frame's request.
- A frame disappearing during broadcast: popup status/actions continue for remaining frames. **Test:** E2E aggregation tolerates a rejected frame message and returns totals from fulfilled frame responses.

---

### Task 1: Enable per-frame injection and popup control

**Files:**
- Modify: `manifests/chrome.json`
- Modify: `manifests/firefox.json`
- Modify: `src/popup/popup.ts`
- Modify: `README.md`
- Test: `tests/e2e/run.mjs`

**Interfaces:**
- Consumes: `PageStatus`, `TabRequest`, `browser.tabs.sendMessage`, and `browser.webNavigation.getAllFrames`.
- Produces: `sendToTab(msg: TabRequest): Promise<PageStatus | null>` sends to each frame ID, ignores individual frame-message rejections, and returns summed counters with `active` true if any responding frame is active; if no frame responds, it reports an error and returns `null`.

- [ ] **Step 1: Add failing E2E coverage**

Add cross-origin and eligible blank/nested iframe content to the test page. Update the E2E tab-message helper to enumerate frame IDs and send each `TabRequest` to its target frame. Assert that translated requests never contain phrases from different documents, iframe text is translated, aggregate status includes frame chunks, and restore reaches all frames. Add an aggregation check where one frame send rejects but fulfilled statuses are still returned.

- [ ] **Step 2: Run the E2E test to verify it fails**

Run: `npm run e2e`
Expected: FAIL because the manifest does not inject into all frames and does not grant `webNavigation`.

- [ ] **Step 3: Enable matching-frame content scripts**

In both manifests, add the `webNavigation` permission and set `all_frames` and `match_about_blank` on the existing `<all_urls>` content-script entry. Do not broaden host permissions.

- [ ] **Step 4: Fan popup actions and status across frames**

Update `sendToTab` in `src/popup/popup.ts` to query `browser.webNavigation.getAllFrames({ tabId })`, send the request to each returned `frameId`, and aggregate fulfilled `PageStatus` values by summing `total`, `done`, `busy`, `queued`, `errors`, and `oversized`, with `active` true if any frame is active. Ignore individual send failures so navigated or non-injectable frames do not hide other frame results; show an error and return `null` if there are no frame responses. Route the diagnostics toggle through this helper too.

- [ ] **Step 5: Document iframe behavior**

Update the README to state that matching injectable frames are translated independently and that browser permissions/restricted pages can prevent injection.

- [ ] **Step 6: Run E2E and type checks**

Run: `npm run e2e && npm run typecheck`
Expected: E2E reports all checks passed; TypeScript exits with code 0.

### Task 2: Verify regression coverage

**Files:**
- Test: `tests/e2e/run.mjs`
- Test: existing test suite

**Interfaces:**
- Consumes: Task 1 frame injection and popup fan-out.
- Produces: verified existing top-frame behavior and iframe isolation.

- [ ] **Step 1: Run focused unit tests**

Run: `npm test`
Expected: Vitest reports all existing tests passed.

- [ ] **Step 2: Build both browser targets**

Run: `npm run build`
Expected: Chrome and Firefox builds complete without errors; generated manifests retain the frame settings and permission.

- [ ] **Step 3: Inspect generated manifests and final diff**

Verify `dist/chrome/manifest.json` and `dist/firefox/manifest.json` include `webNavigation`, `all_frames: true`, and `match_about_blank: true`; confirm no unrelated files changed.
