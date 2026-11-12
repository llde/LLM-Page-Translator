# MutationObserver Diagnostics Design

## Intent

Make dynamic text scanning easier to diagnose by showing what the content
script's `MutationObserver` sees and whether a mutation batch schedules or
resets the debounced scan.

## Approaches

- **Compact callback summary (selected):** log one summary per observer callback
  while Text scan diagnostics is enabled. Include total, relevant, and ignored
  record counts; counts by mutation type; and whether the debounce is unchanged,
  scheduled, or restarted. This helps diagnose filtering and scheduling without
  producing a record-by-record trace.
- **Per-record detail (not selected):** log mutation details and target node
  kind/tag for every record. It provides more detail, but is noisier and exposes
  more page structure than needed.

## Goals and constraints

- Gate every observer diagnostic with the existing per-tab Text scan
  diagnostics setting.
- Report ignored-only callbacks as well as callbacks with relevant mutations.
- Do not log page URLs, text, node names, IDs, or other DOM content.
- Preserve the current relevance filtering, debounce timing, scan behavior, and
  observer lifecycle.

## Non-goals

- No new diagnostic setting or popup control.
- No per-node tracing or changes to which mutations trigger scans.
