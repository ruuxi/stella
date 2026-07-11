import { realpathSync } from "node:fs";
import path from "node:path";

type Waiter = {
  transactionId: string;
  resolve: (release: () => void) => void;
};

type RepoMutationState = {
  owner: string | null;
  waiters: Waiter[];
};

const repoMutationStates = new Map<string, RepoMutationState>();

const canonicalRepoKey = (repoRoot: string): string => {
  const resolved = path.resolve(repoRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

/**
 * One mutation transaction at a time per shared Stella working tree.
 *
 * The lock deliberately does not inspect tool names. Runner wrappers acquire
 * it before logical capture and retain it through the mutation, post-capture,
 * and (for background shells) the final lease poll/kill. A transaction id is
 * unique per tool invocation; shell polls reuse the retained lease instead of
 * acquiring a second lock.
 */
export const acquireSelfModMutationLock = async (
  repoRoot: string,
  transactionId: string,
): Promise<() => void> => {
  const key = canonicalRepoKey(repoRoot);
  let state = repoMutationStates.get(key);
  if (!state) {
    state = { owner: null, waiters: [] };
    repoMutationStates.set(key, state);
  }

  const grant = (target: RepoMutationState, owner: string): (() => void) => {
    target.owner = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (target.owner !== owner) return;
      const next = target.waiters.shift();
      if (next) {
        next.resolve(grant(target, next.transactionId));
        return;
      }
      target.owner = null;
      if (target.waiters.length === 0) repoMutationStates.delete(key);
    };
  };

  if (state.owner === null) return grant(state, transactionId);
  return await new Promise<() => void>((resolve) => {
    state!.waiters.push({ transactionId, resolve });
  });
};

export const getSelfModMutationLockStatus = (
  repoRoot: string,
): { locked: boolean; queued: number } => {
  const state = repoMutationStates.get(canonicalRepoKey(repoRoot));
  return {
    locked: state?.owner != null,
    queued: state?.waiters.length ?? 0,
  };
};
