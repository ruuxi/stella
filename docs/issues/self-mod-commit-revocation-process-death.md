# Self-mod commit revocation is not atomic across third writers and worker death

Status: deferred platform issue
Severity: P1 outside the managed-child prompt-guidance scope

## Problem

The self-mod finalizer removes the active run before its asynchronous dirty scan and Git commit. A later cancellation therefore has no run handle to revoke, and the commit path has no cancellation token to revalidate at the ref update. The cross-process commit lock is also advisory: it reclaims a lock when the recorded PID dies, and after a 400 ms acquisition budget it deliberately proceeds without the file lock. A pre-commit hook can therefore outlive the worker that spawned Git and update `HEAD` after logical ownership has moved on.

Relevant code:

- `runtime/kernel/self-mod/store-mod-service.ts` (`finalizeSelfModRun`, early active-run removal)
- `runtime/kernel/self-mod/git/commit.ts` (`commitGitMessage`, asynchronous Git execution without a revocation token)
- `runtime/kernel/self-mod/git/commit-lock.ts` (`FILE_LOCK_TIMEOUT_MS`, stale-PID reclamation, unlocked fallback)
- `runtime/kernel/self-mod/git/exec.ts` (Git child execution and ref-lock retries)

## Reproduction A: ownership changes while Git is inside a hook

1. Initialize a repository with one seed commit and a pre-commit hook that waits on a release file.
2. Begin an old self-mod run, write a tracked file, and start finalization.
3. Wait until Git enters the hook; the finalizer has already removed the old run from `activeRuns`.
4. Cancel the old run, begin a replacement run, and change the file again. Optionally advance `HEAD` with a third writer while the hook remains blocked.
5. Release the hook.

Observed: the old finalizer can commit after cancellation, including content now owned by the replacement, under the old run's trailers. A third writer can also become part of the resulting history because ownership is not checked at the ref-update boundary.

Expected: revocation prevents the stale finalizer from updating `HEAD`; replacement-owned content remains available for the replacement run.

## Reproduction B: orphan Git child commits after worker death

1. Install a pre-commit hook that writes `.git/hook-started` and waits for `.git/hook-release`.
2. Start `commitGitMessage` in a separate Bun worker for dirty `orphan.txt`.
3. Wait until the hook starts, then `SIGKILL` the worker.
4. Release the hook.

Observed: the orphaned Git child completes and advances `HEAD` even though the owning worker and its synchronous revocation state no longer exist. PID-based advisory-lock reclamation allows another writer to proceed concurrently.

Expected: cancellation and process death must revoke or quarantine the in-flight ref update itself.

## Required platform direction

Use a commit protocol whose ownership token is validated at the ref-update boundary and survives process death. Candidate designs include a dedicated long-lived commit broker, generation-tagged temporary refs followed by a single validated promotion, or another transaction that never exposes an unowned commit through `HEAD`. Do not rely on a JavaScript callback around an async `git commit` or a best-effort PID file as the atomic boundary.

Acceptance coverage must hold a real pre-commit hook, introduce a third writer, kill the owning worker, and prove no canceled commit becomes reachable from the final `HEAD`.
