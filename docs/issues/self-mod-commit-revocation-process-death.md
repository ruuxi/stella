# Self-mod commit revocation is not atomic across third writers and worker death

Status: deferred platform issue
Severity: P1 outside the managed-child v1 scope cut

## Problem

The self-mod finalizer checks run ownership before starting `git commit`, but the asynchronous commit and its ref update are not atomically coupled to that ownership. The cross-process commit lock is advisory: it reclaims a lock when the recorded PID dies, and after a 400 ms acquisition budget it deliberately proceeds without the file lock. A pre-commit hook can therefore outlive the worker that spawned Git and update `HEAD` after ownership has been revoked.

Relevant code:

- `runtime/kernel/self-mod/git/commit.ts` (`commitGitMessage`, ownership check and post-commit rollback)
- `runtime/kernel/self-mod/git/commit-lock.ts` (`FILE_LOCK_TIMEOUT_MS`, stale-PID reclamation, unlocked fallback)
- `runtime/kernel/self-mod/git/exec.ts` (Git child execution and ref-lock retries)

## Reproduction A: third writer defeats rollback CAS

1. Initialize a repository with one seed commit and dirty `stale.txt`.
2. Call `commitGitMessage` for `stale.txt` with a `shouldCommit` callback.
3. Let the initial ownership check return true so the stale commit advances `HEAD`.
4. During the post-commit ownership check, create a third commit with `git commit-tree` and advance `HEAD` to it with `git update-ref`.
5. Return false from `shouldCommit` so the stale finalizer attempts rollback.

Observed: rollback's compare-and-swap fails with `cannot lock ref`, while the third commit retains the stale commit as its parent. The stale commit remains in reachable history with the canceled identity.

Expected: revocation prevents the stale commit from becoming reachable, or a failed rollback leaves the repository in a loudly quarantined state that cannot be mistaken for a valid self-mod result.

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
