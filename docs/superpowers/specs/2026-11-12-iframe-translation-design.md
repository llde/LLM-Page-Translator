# Iframe Translation Design

## Intent

Translate visible text inside embedded frames instead of ignoring it, while keeping each frame's text independent from the containing page and other frames.

## Goals

- Translate text in every frame where the extension can inject its content script, including cross-origin frames when host access permits.
- Keep each frame's scanning, segments, chunks, mutations, and restoration scoped to that frame's document; chunks must never combine text from different frames.
- Make popup start, restore, retry, and status cover all injectable frames in the tab.

## Non-goals and constraints

- Do not bypass browser origin, host-permission, restricted-page, or frame sandbox restrictions.
- Do not change phrase splitting, translation prompts, or chunk limits within a frame.
- Keep Chrome and Firefox support and use the extension's existing browser APIs and content-script pipeline.

## Approaches

- **Independent content script per frame (chosen):** inject into all matching frames and fan popup actions/status across their frame IDs. Uses existing per-document translator state and naturally isolates chunks.
- **Traverse same-origin frames from the top document:** simpler control flow, but cannot read cross-origin frame documents and risks coupling their scan/chunk lifecycle.

The independent-script approach matches the requested separate context and supports cross-origin frames where browser permissions allow it.

## Design

Enable all-frame content-script injection (including eligible blank child frames) for both browser manifests. Route popup tab actions to each frame and combine frame statuses for the existing progress UI. Each content-script instance continues to use its existing scanner, chunk builder, observer, translation port, and restore logic, all operating on that frame's own document. The shared per-tab configuration and translation provider remain unchanged.

## Acceptance

- With translation started from the popup, text in an injectable iframe is translated.
- Main-page text and each frame's text are dispatched as separate chunks; no request mixes segments from different frames.
- Popup status and restore/retry actions account for frames as well as the top document.
- Existing top-frame behavior remains intact.
