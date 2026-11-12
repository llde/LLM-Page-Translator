# Translated Chunk Memory Design

## Intent

Reuse successful chunk translations to avoid repeat AI requests, while keeping
the main page and embedded frames' memories separate and allowing the user to
clear all memory for the current page.

## Goals and constraints

- Persist cached translations across browser and background restarts.
- Reuse a translation only when both the chunk text and translation-affecting
  settings match.
- Isolate the top document from each embedded frame.
- Provide a popup action that clears the current page's top-document and iframe
  memories.
- Expire a page's memory after a configurable number of inactive days, default
  30 days.
- Keep existing translation behavior for cache misses and never cache failures.

## Approaches

- **Persistent storage (chosen):** supports reuse across visits and browser
  restarts; requires page clearing and retention to manage stored data.
- **Browser-session storage:** simpler retention, but loses useful memory when
  the browser closes.
- **In-memory storage:** simplest, but background restarts can discard entries.

Persistent storage best meets the request for memorization; explicit clearing
and configurable expiration manage its lifetime.

## Design

The background translation path checks persistent extension storage before
sending a chunk to the provider. Cache identity includes the page URL, a
frame-specific namespace, the ordered chunk text, and the settings that can
affect the translation. A hit returns the saved translations using the current
segment IDs. Only successful provider responses are saved.

On page activity, entries for that page older than the configured retention
period are removed and its activity time is refreshed. The retention period is
saved with global options and defaults to 30 days. The popup adds a clear-memory
button that asks the background to remove all entries for the current page,
including every frame namespace.

## Non-goals

- No cross-page translation sharing.
- No cache editor or per-chunk deletion UI.
- No changes to chunking, prompts, or provider behavior on a cache miss.
