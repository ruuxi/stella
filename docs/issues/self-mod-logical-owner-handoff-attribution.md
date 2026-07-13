# Logical-thread handoff can attribute abandoned work to an unrelated later run

Status: deferred platform issue
Severity: P1 outside the managed-child prompt-guidance scope

## Problem

The reviewed ownership-handoff design preserved a canceled run's baseline under its logical `ownershipKey`, then let the next run with that key consume the handoff. Without a takeover epoch, adjacency requirement, or expiry, a later unrelated task reusing the same durable thread could inherit abandoned dirty paths and commit them under its own task identity.

Relevant historical code:

- `runtime/kernel/self-mod/store-mod-service.ts` (`beginSelfModRun`, `cancelSelfModRun`, and the former `canceledBaselinesByOwner` handoff)

## Reproduction

1. Begin `old-run` with `ownershipKey: "durable-thread"`.
2. Write `old.ts` at the repository root.
3. Cancel the Store self-mod run, leaving `old.ts` dirty.
4. Later, begin `later-run` with the same ownership key but an unrelated task description.
5. Write `later.ts` and finalize the later Store run.

Observed in the reviewed handoff implementation: the later Git commit contained both `old.ts` and `later.ts`, attributing the abandoned file to unrelated later work.

The root-level repro establishes Store commit-attribution leakage only. Root-level `old.ts` and `later.ts` are not self-mod-relevant HMR paths, so it does **not** establish a mismatch with the HMR apply delta. Any future HMR-specific reproduction must use relevant paths such as `desktop/src/old.ts` and `desktop/src/later.ts` and assert that behavior separately.

Expected: handoff is available only to the immediate replacement attempt in the same takeover chain. Unclaimed abandoned paths must expire, be restored or quarantined, or remain explicitly associated with the canceled attempt.

## Required platform direction

If logical ownership transfer is reintroduced, represent it with a persisted takeover token or monotonically increasing epoch naming both predecessor and immediate successor. Require adjacency and a short validity window; consume the handoff exactly once. A later normal resume or unrelated task on the same durable thread must not qualify.

Acceptance coverage must use a real repository and prove both sides: an immediate replacement can claim intentionally transferred work, while a later unrelated run cannot commit the abandoned path. HMR attribution requires a separate relevant-path case.
