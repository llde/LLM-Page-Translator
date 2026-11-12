# Translation Memory Diagnostics Design

## Intent

Make translation-memory behavior observable using the existing per-tab Text
scan diagnostics setting, without changing translation behavior or adding a
second toggle.

## Goals and constraints

- Log memory hits, misses, successful stores, expired entries, and page clears
  only when the relevant tab has text diagnostics enabled.
- Include useful chunk/frame identifiers and counts, but never log page URLs,
  source text, or translations.
- Keep diagnostics in the background where memory operations already occur.

## Approaches

- **Background lifecycle logs (chosen):** use the existing effective per-tab
  setting at each memory operation; only the popup clear request needs to pass
  its tab ID for the background to load that setting.
- **Forward diagnostics through content scripts:** would add message traffic
  and duplicate state for operations owned by the background.

## Design

Emit structured diagnostic events for memory lookup hit/miss, successful
provider-result storage, retention cleanup, and popup clearing. Return cleanup
and clear counts from the memory helper so logs describe actual changes. The
background loads the tab's diagnostics setting for a clear request using the
tab ID supplied by the popup. Do not include page URLs or text in these events.

## Non-goals

- No new settings or controls.
- No changes to cache identity, retention, or translation results.
