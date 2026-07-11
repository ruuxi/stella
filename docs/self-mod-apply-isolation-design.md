# Design of record: per-run self-mod apply isolation

Stella keeps one shared working tree. Every orchestrator and subagent tool
transaction takes the same repo mutation lock from pre-write capture through
post-write capture; a background shell retains both the lock and capture until
its final poll or forced termination. The logical change-set store records raw
file states (bytes, blob/symlink kind, and Git mode), with the first touched
state as the per-run/per-file base and only that run's mediated deltas as its
incoming state.

Applying selector X holds the Git commit lock while it re-reads HEAD, performs
a three-way merge (`base=X base`, `theirs=X authored delta`, `ours=live HEAD`),
and creates an exact temporary-index commit with an expected-parent CAS. The
real index advances only where its entry still matched the old HEAD. Vite gets
the selected versioned snapshot as an overlay and never reconciles it back to
the shared disk. A process restart first rebuilds disk under the mutation lock
as `new HEAD + every still-pending/active logical delta`.

Text blobs auto-merge only when their true changed regions do not collide.
Literal same-line overlap, binary/base divergence, incompatible mode changes,
and add/delete collisions return a structured conflict without touching HEAD,
the index, disk bytes, or pending selectors. Conflict display excerpts are
bounded; full raw states remain only in the persisted pending-resolution row.
Discard and seven-day expiry remove the logical state, coordinator envelope,
Vite pins, reload lease, and card state, then reconstruct the remaining live
tree. Pending selectors are persisted in SQLite and restored with their HMR
ownership after a worker restart. Each selector has its own card event; an
explicit Update all action remains separate.

The production-path harness drives deterministic fake mutations through both
real runner wrappers, mediated capture, the shared mutation lock, coordinator
finalize/apply, exact Git commit, real index, real Vite plugin HTTP endpoint,
HMR overlay payload, and long-running shell leases. It asserts HEAD, index,
shared-disk bytes, pending selectors/cards, payloads, conflicts, retry, and
cleanup across the concurrency matrix.
