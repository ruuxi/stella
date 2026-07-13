# Logical-thread handoff can attribute abandoned work to an unrelated later run

Status: deferred platform issue
Severity: P1 outside the managed-child v1 scope cut

## Problem

`StoreModService.cancelSelfModRun` preserves a canceled run's baseline under its logical `ownershipKey`. The next run with that key consumes the handoff in `beginSelfModRun`. There is no takeover epoch, adjacency requirement, or expiry, so a later unrelated task that reuses the same durable thread can inherit abandoned dirty paths and commit them under its own task identity.

Relevant code:

- `runtime/kernel/self-mod/store-mod-service.ts` (`beginSelfModRun`, `cancelSelfModRun`, `canceledBaselinesByOwner`)
- `runtime/kernel/self-mod/hmr.ts` (per-run path tracking and apply delta)

## Reproduction

1. Begin `old-run` with `ownershipKey: "durable-thread"`.
2. Write and HMR-track `old.ts`.
3. Cancel both the HMR run and the Store self-mod run, leaving `old.ts` dirty.
4. Later, begin `later-run` with the same ownership key but an unrelated task description.
5. Write and HMR-track only `later.ts`.
6. Finalize the Store run and the HMR run.

Observed: the Git commit contains both `old.ts` and `later.ts`, while the HMR apply delta contains only `later.ts`. The unrelated later task is credited with abandoned work it did not perform, and apply-isolation attribution diverges from commit attribution.

Expected: handoff is available only to the immediate replacement attempt in the same takeover chain. Unclaimed abandoned paths must expire, be restored/quarantined, or remain explicitly associated with the canceled attempt.

## Required platform direction

Represent ownership transfer with a persisted takeover token or monotonically increasing epoch that names both predecessor and immediate successor. Require adjacency and a short validity window; consume the handoff exactly once. A later normal resume or unrelated task on the same durable thread must not qualify.

Acceptance coverage must use a real repository and prove both sides: an immediate pause/resume replacement can commit the inherited logical work, while a later unrelated run cannot commit or apply the abandoned path.
