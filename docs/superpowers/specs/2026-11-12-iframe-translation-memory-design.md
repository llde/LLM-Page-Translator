# Stable iframe translation-memory identity

## Intent

Reuse translated chunks after a page reload, including in embedded frames. Browser frame IDs change across reloads, so they must not be part of the persisted cache identity.

## Goals and constraints

- Keep top-level and embedded-frame entries separate.
- Keep nested frame paths distinct while making identity stable across reloads.
- Identical-URL sibling frames under the same parent may share entries.
- Preserve existing settings, source-text, page, retention, and clear-page behavior.

## Approaches

- **Stable URL ancestry (selected):** identify a frame by its normalized URL path from the page through the frame. Stable across reloads, distinguishes different frame paths, and permits identical sibling URLs to share.
- **Per-element identity:** assign a persistent identity to each iframe element and coordinate it across parent/child frames. Strictly isolates siblings but adds cross-origin coordination and lifecycle complexity.
- **Frame URL alone:** simple and reload-stable, but can collide across distinct nested paths.

Use stable URL ancestry; it meets the reload reuse goal while retaining meaningful frame isolation without introducing iframe coordination.

## Implementation and verification

Build the ancestry from browser frame metadata rather than DOM access, so cross-origin frames are supported. Add focused memory tests for reload-stable frame identity and distinct ancestry, retain the end-to-end reload reuse regression check, and run the relevant tests and build checks.
