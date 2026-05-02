/**
 * Tracks per-path ownership across concurrently-active self-mod runs and
 * decides when each run's changes can become visible to the renderer.
 *
 * The unit of contention is a path, but the unit of hold-or-apply is a run:
 * a finalizing run is held atomically until every path it touched has no
 * other *active* (unfinalized) owner. Finalized-but-held owners do not
 * block: when the last active overlap clears, the held runs drain together
 * as one batch.
 *
 * Pathological case the held-set distinction prevents:
 * - A and B both touched foo.tsx; A finalizes, B is still active → hold A.
 *   Without the distinction, when B finalizes it would also be held by A,
 *   producing a deadlock. With it, B sees A only as `finalizedHeld` and
 *   drains both runs together.
 *
 * "New active owner extends the hold" is also encoded here: if C starts
 * after A is held and writes to foo.tsx, A keeps waiting because foo.tsx
 * has an `active` owner again.
 */

export type RunStatus = "active" | "finalizedHeld";

export type ContendedRun = {
  runId: string;
  touchedPaths: ReadonlySet<string>;
};

export type ApplyDecision = {
  applyBatch: ContendedRun[];
  /**
   * Paths whose ownership ended without an `applyBatch` taking responsibility
   * for them — currently produced only by `cancel` when the cancelled run
   * was the sole owner of a path. The Vite plugin uses this to drop the
   * pinned snapshot so subsequent module loads fall back to disk.
   */
  releasedPaths: string[];
};

export type RecordWriteResult = {
  /**
   * Paths that just transitioned from "no owner" to "first owner" in this
   * call. The orchestrator forwards these to the Vite plugin so the
   * pre-period snapshot can be captured before any other agent's write
   * mutates disk.
   */
  newlyTrackedPaths: string[];
};

type RunState = {
  runId: string;
  touchedPaths: Set<string>;
  status: RunStatus;
  finalizedOrder?: number;
};

export type ContentionTracker = {
  recordWrite: (runId: string, paths: Iterable<string>) => RecordWriteResult;
  finalize: (runId: string) => ApplyDecision;
  cancel: (runId: string) => ApplyDecision;
  beginRun: (runId: string) => void;
  hasRun: (runId: string) => boolean;
  getRunStatus: (runId: string) => RunStatus | null;
  getActiveRunIds: () => string[];
  getHeldRunIds: () => string[];
  getOwners: (path: string) => Array<{ runId: string; status: RunStatus }>;
};

export const createContentionTracker = (): ContentionTracker => {
  const runs = new Map<string, RunState>();
  const pathOwners = new Map<string, Map<string, RunStatus>>();
  let nextFinalizedOrder = 0;

  const startRun = (runId: string): RunState => {
    const existing = runs.get(runId);
    if (existing) return existing;
    const state: RunState = {
      runId,
      touchedPaths: new Set(),
      status: "active",
    };
    runs.set(runId, state);
    return state;
  };

  const releaseRun = (state: RunState, releasedPaths?: string[]): void => {
    for (const pathKey of state.touchedPaths) {
      const owners = pathOwners.get(pathKey);
      if (!owners) continue;
      owners.delete(state.runId);
      if (owners.size === 0) {
        pathOwners.delete(pathKey);
        if (releasedPaths) releasedPaths.push(pathKey);
      }
    }
    runs.delete(state.runId);
  };

  const hasActiveOverlap = (state: RunState): boolean => {
    for (const pathKey of state.touchedPaths) {
      const owners = pathOwners.get(pathKey);
      if (!owners) continue;
      for (const [ownerRunId, ownerStatus] of owners) {
        if (ownerRunId === state.runId) continue;
        if (ownerStatus === "active") return true;
      }
    }
    return false;
  };

  const drain = (extraReleased?: string[]): ApplyDecision => {
    const unblocked: ContendedRun[] = [];
    for (const state of runs.values()) {
      if (state.status !== "finalizedHeld") continue;
      if (hasActiveOverlap(state)) continue;
      unblocked.push({
        runId: state.runId,
        touchedPaths: new Set(state.touchedPaths),
      });
    }
    unblocked.sort((a, b) => {
      const aOrder = runs.get(a.runId)?.finalizedOrder ?? 0;
      const bOrder = runs.get(b.runId)?.finalizedOrder ?? 0;
      return aOrder - bOrder;
    });
    for (const run of unblocked) {
      const state = runs.get(run.runId);
      // Apply transfers ownership to the overlay; we don't surface those
      // paths in `releasedPaths` because they're already accounted for in
      // applyBatch.
      if (state) releaseRun(state);
    }
    return {
      applyBatch: unblocked,
      releasedPaths: extraReleased ? [...new Set(extraReleased)] : [],
    };
  };

  return {
    beginRun(runId) {
      startRun(runId);
    },

    recordWrite(runId, paths) {
      // recordWrite is a no-op for unknown runs. The orchestrator MUST call
      // beginRun before any writes; this also means writes that arrive after
      // finalize (which removes the run) are correctly ignored instead of
      // resurrecting a phantom active owner.
      const newlyTrackedPaths: string[] = [];
      const state = runs.get(runId);
      if (!state) return { newlyTrackedPaths };
      if (state.status !== "active") return { newlyTrackedPaths };
      for (const rawPath of paths) {
        if (typeof rawPath !== "string" || rawPath.length === 0) continue;
        if (state.touchedPaths.has(rawPath)) continue;
        state.touchedPaths.add(rawPath);
        let owners = pathOwners.get(rawPath);
        const isNewPath = !owners;
        if (!owners) {
          owners = new Map();
          pathOwners.set(rawPath, owners);
        }
        owners.set(runId, "active");
        if (isNewPath) newlyTrackedPaths.push(rawPath);
      }
      return { newlyTrackedPaths };
    },

    finalize(runId) {
      const state = runs.get(runId);
      if (!state) {
        return { applyBatch: [], releasedPaths: [] };
      }
      if (state.touchedPaths.size === 0) {
        releaseRun(state);
        return { applyBatch: [], releasedPaths: [] };
      }
      state.status = "finalizedHeld";
      state.finalizedOrder = nextFinalizedOrder;
      nextFinalizedOrder += 1;
      for (const pathKey of state.touchedPaths) {
        const owners = pathOwners.get(pathKey);
        if (owners) owners.set(runId, "finalizedHeld");
      }
      return drain();
    },

    cancel(runId) {
      const state = runs.get(runId);
      if (!state) {
        return { applyBatch: [], releasedPaths: [] };
      }
      const released: string[] = [];
      releaseRun(state, released);
      return drain(released);
    },

    hasRun(runId) {
      return runs.has(runId);
    },

    getRunStatus(runId) {
      return runs.get(runId)?.status ?? null;
    },

    getActiveRunIds() {
      const ids: string[] = [];
      for (const state of runs.values()) {
        if (state.status === "active") ids.push(state.runId);
      }
      return ids;
    },

    getHeldRunIds() {
      const ids: string[] = [];
      for (const state of runs.values()) {
        if (state.status === "finalizedHeld") ids.push(state.runId);
      }
      return ids;
    },

    getOwners(pathKey) {
      const owners = pathOwners.get(pathKey);
      if (!owners) return [];
      return Array.from(owners, ([runId, status]) => ({ runId, status }));
    },
  };
};
