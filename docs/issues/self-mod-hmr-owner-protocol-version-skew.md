# Owner-tagged HMR pins are incompatible across self-update version skew

Status: deferred platform issue
Severity: P1 outside the managed-child v1 scope cut

## Problem

Path pins are now owner-tagged by `runId`, and `/untrack-paths` removes only pins held by the requesting owner. That closes stale-cancellation races when the runtime and Vite plugin are on the same version, but Stella updates those two sides across a live transition:

- New runtime to old plugin: the runtime sends `runId`; an old plugin does not understand owner-tagged semantics and removes the path globally, so a stale retry can delete a replacement run's pin.
- Old runtime to new plugin: the new plugin requires `runId` and returns HTTP 400 to the old client, so pins and client-update pauses can remain held.

Relevant code:

- `runtime/kernel/self-mod/hmr.ts` (`trackPaths`, `untrackPaths`, cleanup acknowledgements)
- `desktop/vite/self-mod-hmr-plugin.ts` (`/track-paths` and `/untrack-paths` request validation and owner matching)

## Reproduction A: old client against new plugin

1. Run the current Vite plugin.
2. POST the legacy `/track-paths` or `/untrack-paths` body containing only `paths`.
3. Observe HTTP 400 because `runId` is required.

Expected during a supported update window: the plugin negotiates or safely handles the legacy protocol without stranding resources.

## Reproduction B: new client against old plugin

1. Run the pre-owner-tag Vite plugin, where path pins are global.
2. Have an old run pin a path, then let a replacement run re-pin the same path.
3. Replay the old run's current-runtime `/untrack-paths` retry with its `runId`.

Observed: the old plugin ignores owner identity and removes the replacement's global pin, exposing replacement work to renderer updates.

Expected: a stale owner can release only its own claim.

## Required platform direction

Version the HMR control protocol and make compatibility explicit. The client should advertise a protocol version or capabilities, and the plugin should return its supported version. Keep a bounded dual-protocol transition path: legacy messages must be interpreted conservatively, and owner-tag operations must never be silently downgraded to path-global deletion. If safe compatibility is impossible, fail closed with a user-visible update diagnostic and a deterministic recovery action.

Acceptance coverage must exercise both skew directions using real HTTP handlers, including stale retry after replacement re-track, cleanup acknowledgement, client-update release, and upgrade recovery.
