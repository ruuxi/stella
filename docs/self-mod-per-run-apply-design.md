# Per-run self-mod apply isolation: design of record

Status: implementation target for `codex/self-mod-apply-isolation`.

## Invariants

1. Stella keeps one shared working tree. Agents read and write the live files normally and therefore see earlier in-progress edits, including staggered starts.
2. Every mediated mutation is serialized at the existing agent filesystem-lock boundary. Immediately before and after the mutation, Stella captures the touched file states and attributes only that delta to the active self-mod run.
3. The first pre-write state for each run/file is that run's logical base. Later writes accumulate as authored deltas; bytes inherited from another run's in-progress state are never promoted to authored bytes.
4. Finalizing an author run freezes a pending logical change set but does not sweep whole dirty paths into `HEAD`. The shared working tree remains untouched so other active agents keep seeing the live state.
5. Applying run X re-reads the current applied `HEAD` and performs a three-way merge per file: base = X's logical base, incoming = base plus only X's authored deltas, local = the file in current `HEAD`. A clean result is committed through an isolated Git index, so `HEAD` advances with exactly X while the working tree continues to contain every still-pending live edit.
6. The HMR apply payload is built from the selected merge result, never from current disk content. Clicking an inline card selects its own change-set id. A separate explicit apply-all operation selects all finalized pending change sets in deterministic finalize order.
7. Re-applying an already-applied change set is idempotent and does not create another commit or HMR transition.

## Change locations

- `runtime/kernel/self-mod/logical-change-set.ts`: per-run bases, serialized before/after write capture, authored-delta accumulation, finalization, three-way merge, conflict descriptions, and lifecycle cleanup.
- `runtime/kernel/self-mod/hmr.ts`: owns the logical patch layer beside contention/HMR state; exposes mediated-write capture and builds HMR runs from selected merged content.
- `runtime/kernel/runner/agent-orchestration.ts` and `orchestrator-launch.ts`: bracket real tool execution with before/after capture while the existing `LocalAgentManager` filesystem lock is held. Mutating shell guards feed their detected paths through the same capture contract.
- `runtime/kernel/self-mod/store-mod-service.ts` and `git/commit.ts`: stop author-mode whole-path finalization; derive metadata from the frozen logical change set and commit exact merged file states with the existing per-repo commit lock and an isolated index. Install/update modes retain their current immediate behavior.
- `runtime/worker/self-mod-coordinator.ts`: store pending entries by change-set/run identity, apply one selector rather than draining the map, expose explicit apply-all, preserve pending entries on conflict, and dispatch only successfully merged HMR files.
- `runtime/contracts/local-chat.ts`, `desktop/src/features/chat/self-mod-types.ts`, protocol/host/preload IPC contracts, and `SelfModUndoButton.tsx`: carry the real change-set selector and structured pending/conflict/applied state to the card.
- `desktop/vite/self-mod-hmr-plugin.ts`: continue applying explicit file payloads; never fall back to shared-disk bytes for new per-run batches.
- `desktop/tests/runtime/worker/self-mod-concurrency-harness.test.ts`: scripted synthetic agents drive begin, mediated writes, finalize, selective apply/merge, Git `HEAD`, and HMR through the real coordinator/controller/service path.

## Conflict policy

Text edits are merged by the existing source-pack three-way merge. Changes to disjoint base ranges, including different regions of one file, merge automatically in either apply order. If both current `HEAD` and the selected run changed the same base lines to different content, apply returns a structured `text-conflict` containing the path and base/local/incoming excerpts. Binary, add/delete, and attribution-accumulation ambiguities return the corresponding structured conflict. A conflicted apply is atomic: it advances neither `HEAD` nor card status, writes no conflict markers into the shared tree, and sends no HMR apply. The pending card remains available for resolution/retry.

The test worktree and dev instance are only development infrastructure. No worktree participates in the shipped isolation mechanism.
