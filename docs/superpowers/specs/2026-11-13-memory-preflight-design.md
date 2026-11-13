# Memory preflight before provider concurrency

## Intent

Cached chunks should be looked up and applied without waiting for the configured “Parallel requests” limit. That limit controls only requests sent to the LLM.

## Selected approach

Separate cache lookup from provider dispatch. The content script starts a memory preflight for each eligible chunk without consuming an LLM concurrency slot. A hit is applied immediately; a miss returns to the existing viewport-prioritized queue, where the configured limit controls provider requests. The background's provider path stores successful translations but does not repeat the preflight lookup.

## Constraints and non-goals

- Preserve existing chunk ordering/viewport priority and queued/busy status behavior for provider work.
- Keep cache identity, translation settings, error handling, and memory diagnostics behavior unchanged.
- A frame-ancestry lookup failure acts as a cache miss; a failure to read stored memory remains an explicit error.
- Do not change the configured concurrency limit or how many provider requests it permits.

## Verification

Add focused coverage that demonstrates memory lookup and hit handling do not consume provider concurrency, while cache misses still pass through the existing limit. Run unit tests, typecheck, and E2E checks for cache hits and provider concurrency.
