import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "timers/promises";

import {
  createContentionTracker,
  type ApplyDecision,
  type ContendedRun,
  type ContentionTracker,
  type RunStatus,
} from "./contention-tracker.js";
import {
  isFullReloadRelevantPath,
  isRestartRelevantPath,
  isRestartRequiredNonHmrPath,
  isViteTrackablePath,
  toSelfModRelevantKey,
} from "./path-relevance.js";

const HMR_ENDPOINT_BASE = "/__stella/self-mod/hmr";
// Per-attempt timeout — kept tight so we get multiple retries inside the
// total budget when the dev server is slow to accept the connection.
const REQUEST_TIMEOUT_MS = 1_500;
// Total wait budgets — a healthy HMR call completes in well under a second;
// anything past this points at a wedged dev server and we'd rather fail
// fast than block the agent.
const TRACK_MAX_WAIT_MS = 5_000;
const APPLY_MAX_WAIT_MS = 10_000;

type HmrControllerOptions = {
  getDevServerUrl: () => string;
  /**
   * When false (production / packaged build), the controller still drives
   * the in-process tracker so per-run apply decisions are correctly
   * computed, but it skips the HTTP calls to the Vite plugin (which isn't
   * running). The decision still flows back to the worker so the runtime
   * restart pipeline can release pauses normally.
   */
  enabled: boolean;
  /**
   * Repository root used to normalize incoming absolute paths to the
   * repo-relative form the tracker and overlay agree on.
   */
  repoRoot: string;
  authToken?: string;
};

export type HmrStatus = {
  paused: boolean;
  inFlightPaths: number;
  appliedOverlayPaths: number;
};

export type AppliedRun = {
  runId: string;
  paths: string[];
  files: Array<{ path: string; content?: string; deleted?: boolean }>;
  restartRelevantPaths: string[];
  fullReloadRelevantPaths: string[];
};

export type ApplyResult = {
  appliedRuns: AppliedRun[];
  /**
   * RunIds whose runtime-reload pause should be released. Always equal to
   * `appliedRuns.map(r => r.runId)`; surfaced separately so callers don't
   * need to recompute it.
   */
  restartRelevantRunIds: string[];
  /**
   * True when at least one applied path is restart-relevant — caller can
   * use this as a hint for log messages, but the worker should release
   * runtime-reload pauses for every appliedRunId regardless (the
   * dev-watcher debouncer coalesces no-op cases on its own).
   */
  hasRestartRelevantPaths: boolean;
  hasFullReloadRelevantPaths: boolean;
};

export type ApplyOptions = {
  suppressClientFullReload?: boolean;
  forceClientFullReload?: boolean;
};

export type RecordWriteOptions = {
  /**
   * Pre-write tracking pins Vite's pre-period snapshot and records ownership,
   * but it must not capture the run's apply content until the tool has
   * actually written the file.
   */
  captureSnapshot?: boolean;
};

export type CancelResult = ApplyResult & {
  releasedPaths: string[];
};

const withTimeoutSignal = (timeoutMs: number): AbortSignal => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener(
    "abort",
    () => clearTimeout(timer),
    { once: true },
  );
  return controller.signal;
};

const postWithRetry = async (args: {
  getDevServerUrl: () => string;
  path: string;
  maxWaitMs: number;
  body?: unknown;
  authToken?: string;
}): Promise<boolean> => {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < args.maxWaitMs) {
    attempt += 1;
    const baseUrl = args.getDevServerUrl().replace(/\/+$/, "");
    const target = `${baseUrl}${args.path}`;

    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(args.authToken
            ? { "X-Stella-Self-Mod-Hmr-Token": args.authToken }
            : {}),
        },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
        signal: withTimeoutSignal(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 401 || response.status === 403) {
        return false;
      }

      if (response.ok) {
        return true;
      }

      if (response.status === 404) {
        return false;
      }
    } catch {
      // Vite may be restarting (dependency install / optimize); retry until maxWait.
    }

    const backoffMs = Math.min(1_500, 250 * attempt);
    await delay(backoffMs);
  }

  return false;
};

const partitionRestartPaths = (paths: string[]): string[] =>
  paths.filter(
    (repoRelativePath) =>
      isRestartRelevantPath(repoRelativePath) ||
      isRestartRequiredNonHmrPath(repoRelativePath),
  );

const partitionFullReloadPaths = (paths: string[]): string[] =>
  paths.filter(isFullReloadRelevantPath);

const readSnapshotContent = (
  repoRoot: string,
  repoRelativePath: string,
): { content?: string; deleted?: boolean } => {
  try {
    return {
      content: readFileSync(path.resolve(repoRoot, repoRelativePath), "utf-8"),
    };
  } catch {
    return { deleted: true };
  }
};

const buildAppliedRuns = (
  batch: ContendedRun[],
  snapshots: Map<string, Map<string, string | null>>,
  repoRoot: string,
): AppliedRun[] =>
  batch.map((run) => {
    const paths = Array.from(run.touchedPaths);
    const snapshot = snapshots.get(run.runId);
    return {
      runId: run.runId,
      paths,
      files: paths.map((filePath) => {
        if (snapshot?.has(filePath)) {
          const content = snapshot.get(filePath);
          return content == null
            ? { path: filePath, deleted: true }
            : { path: filePath, content };
        }
        return { path: filePath, ...readSnapshotContent(repoRoot, filePath) };
      }),
      restartRelevantPaths: partitionRestartPaths(paths),
      fullReloadRelevantPaths: partitionFullReloadPaths(paths),
    };
  });

const buildApplyResult = (
  decision: ApplyDecision,
  snapshots: Map<string, Map<string, string | null>>,
  repoRoot: string,
): ApplyResult => {
  const appliedRuns = buildAppliedRuns(
    decision.applyBatch,
    snapshots,
    repoRoot,
  );
  const restartRelevantRunIds = appliedRuns.map((run) => run.runId);
  const hasRestartRelevantPaths = appliedRuns.some(
    (run) => run.restartRelevantPaths.length > 0,
  );
  const hasFullReloadRelevantPaths = appliedRuns.some(
    (run) => run.fullReloadRelevantPaths.length > 0,
  );
  return {
    appliedRuns,
    restartRelevantRunIds,
    hasRestartRelevantPaths,
    hasFullReloadRelevantPaths,
  };
};

export type SelfModHmrController = {
  beginRun: (runId: string) => Promise<void>;
  /**
   * Records a write by the given run. Absolute paths are normalized via the
   * shared path-relevance filter; out-of-scope paths are silently dropped.
   * Newly tracked paths are forwarded to the Vite plugin so it can pin a
   * pre-period snapshot for them.
   */
  recordWrite: (
    runId: string,
    absolutePaths: Iterable<string>,
    options?: RecordWriteOptions,
  ) => Promise<void>;
  /**
   * Marks `runId` as finalized. Returns the runs whose changes just became
   * visible to the renderer (either this run if uncontended, or this run
   * plus any held runs whose contention with this one just cleared).
   *
   * This call only updates the in-process tracker — the caller is
   * responsible for invoking `apply(appliedRuns)` once it has wrapped the
   * Vite-side overlay swap in a morph cover. Splitting it this way lets the
   * orchestrator hide the renderer flicker behind the cover.
   */
  finalize: (runId: string) => ApplyResult;
  /**
   * Cancels `runId`. Returns any runs that drained as a side-effect, plus
   * paths whose last owner just cancelled. POSTs `/untrack-paths` for
   * `releasedPaths` immediately (no morph cover needed for snapshot drops);
   * the caller is responsible for applying any drained held runs.
   */
  cancel: (runId: string) => Promise<CancelResult>;
  /**
   * Posts the actual overlay update + targeted HMR for `appliedRuns`. The
   * orchestrator calls this from inside its morph cover, after the cover
   * is on screen, so the renderer never visually crosses a stale->fresh
   * boundary.
   */
  apply: (
    appliedRuns: AppliedRun[],
    options?: ApplyOptions,
  ) => Promise<boolean>;
  /**
   * Clears Vite-side pins/overlays for an apply batch that failed after its
   * runs were released from the controller. This is intentionally narrower
   * than forceResumeAll so unrelated active runs keep their isolation state.
   */
  discard: (appliedRuns: AppliedRun[]) => Promise<boolean>;
  releaseRuns: (runIds: string[]) => Promise<boolean>;
  beginShellMutationGuard: () => Promise<boolean>;
  endShellMutationGuard: () => Promise<boolean>;
  /**
   * Emergency: clear all tracker state and tell Vite to drop overlays.
   * Used from runtime initialization and after fatal errors so a stale
   * pause from a previous session doesn't permanently freeze HMR.
   */
  forceResumeAll: () => Promise<boolean>;
  getStatus: () => Promise<HmrStatus | null>;
  hasRun: (runId: string) => boolean;
  getRunStatus: (runId: string) => RunStatus | null;
  // Exposed for tests and for surfaces that want to introspect contention.
  __tracker: ContentionTracker;
};

export const createSelfModHmrController = (
  options: HmrControllerOptions,
): SelfModHmrController => {
  const tracker = createContentionTracker();
  const touchedPathsByRun = new Map<string, Set<string>>();
  const finalizedSnapshotsByRun = new Map<
    string,
    Map<string, string | null>
  >();

  const snapshotPathForRun = (runId: string, repoRelativePath: string): void => {
    let snapshot = finalizedSnapshotsByRun.get(runId);
    if (!snapshot) {
      snapshot = new Map();
      finalizedSnapshotsByRun.set(runId, snapshot);
    }
    const snapshotContent = readSnapshotContent(
      options.repoRoot,
      repoRelativePath,
    );
    snapshot.set(
      repoRelativePath,
      snapshotContent.deleted ? null : snapshotContent.content ?? "",
    );
  };

  const trackPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0 || !options.enabled) return;
    const tracked = await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/track-paths`,
      maxWaitMs: TRACK_MAX_WAIT_MS,
      body: { paths },
      authToken: options.authToken,
    });
    if (!tracked) {
      throw new Error("Failed to pin self-mod HMR paths before write.");
    }
  };

  const pauseClientUpdates = async (runId: string): Promise<void> => {
    if (!options.enabled) return;
    const paused = await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/pause-client-updates`,
      maxWaitMs: TRACK_MAX_WAIT_MS,
      body: { runId },
      authToken: options.authToken,
    });
    if (!paused) {
      throw new Error("Failed to pause self-mod HMR client updates.");
    }
  };

  const releaseClientUpdates = async (runIds: string[]): Promise<boolean> => {
    if (runIds.length === 0 || !options.enabled) return true;
    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/release-client-updates`,
      maxWaitMs: TRACK_MAX_WAIT_MS,
      body: { runIds },
      authToken: options.authToken,
    });
  };

  const untrackPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0 || !options.enabled) return;
    await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/untrack-paths`,
      maxWaitMs: TRACK_MAX_WAIT_MS,
      body: { paths },
      authToken: options.authToken,
    });
  };

  const sendApply = async (
    appliedRuns: AppliedRun[],
    applyOptions?: ApplyOptions,
  ): Promise<boolean> => {
    if (appliedRuns.length === 0 || !options.enabled) return true;
    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/apply`,
      maxWaitMs: APPLY_MAX_WAIT_MS,
      body: {
        runs: appliedRuns.map((run) => ({
          runId: run.runId,
          paths: run.paths,
          files: run.files,
        })),
        ...(applyOptions ? { options: applyOptions } : {}),
      },
      authToken: options.authToken,
    });
  };

  const sendDiscard = async (appliedRuns: AppliedRun[]): Promise<boolean> => {
    if (appliedRuns.length === 0 || !options.enabled) return true;
    const paths = [
      ...new Set(
        appliedRuns.flatMap((run) =>
          run.paths.filter((repoRelativePath) =>
            isViteTrackablePath(repoRelativePath),
          ),
        ),
      ),
    ];
    if (paths.length === 0) return true;
    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path: `${HMR_ENDPOINT_BASE}/discard`,
      maxWaitMs: TRACK_MAX_WAIT_MS,
      body: { paths },
      authToken: options.authToken,
    });
  };

  const postGuard = async (path: string): Promise<boolean> => {
    if (!options.enabled) return true;
    return await postWithRetry({
      getDevServerUrl: options.getDevServerUrl,
      path,
      maxWaitMs: TRACK_MAX_WAIT_MS,
      authToken: options.authToken,
    });
  };

  const snapshotRun = (runId: string): void => {
    const paths = touchedPathsByRun.get(runId);
    if (!paths || paths.size === 0) {
      return;
    }
    const snapshot = finalizedSnapshotsByRun.get(runId) ?? new Map();
    for (const repoRelativePath of paths) {
      if (!snapshot.has(repoRelativePath)) {
        snapshotPathForRun(runId, repoRelativePath);
      }
    }
  };

  const dropRunState = (runIds: Iterable<string>): void => {
    for (const runId of runIds) {
      touchedPathsByRun.delete(runId);
      finalizedSnapshotsByRun.delete(runId);
    }
  };

  const finishApplyResult = (decision: ApplyDecision): ApplyResult => {
    const result = buildApplyResult(
      decision,
      finalizedSnapshotsByRun,
      options.repoRoot,
    );
    dropRunState(result.appliedRuns.map((run) => run.runId));
    return result;
  };

  return {
    async beginRun(runId) {
      tracker.beginRun(runId);
      touchedPathsByRun.set(runId, new Set());
      try {
        await pauseClientUpdates(runId);
      } catch (error) {
        tracker.cancel(runId);
        touchedPathsByRun.delete(runId);
        finalizedSnapshotsByRun.delete(runId);
        throw error;
      }
    },

    async recordWrite(runId, absolutePaths, recordOptions) {
      const repoRelative: string[] = [];
      for (const absPath of absolutePaths) {
        const key = toSelfModRelevantKey(absPath, options.repoRoot);
        if (key) repoRelative.push(key);
      }
      if (repoRelative.length === 0) return;
      if (tracker.getRunStatus(runId) !== "active") return;
      const captureSnapshot = recordOptions?.captureSnapshot !== false;
      const touchedPaths = touchedPathsByRun.get(runId);
      const alreadyOwnedPaths = repoRelative.filter((repoRelativePath) =>
        tracker
          .getOwners(repoRelativePath)
          .some((owner) => owner.runId === runId),
      );
      if (captureSnapshot && touchedPaths) {
        for (const repoRelativePath of alreadyOwnedPaths) {
          touchedPaths.add(repoRelativePath);
          snapshotPathForRun(runId, repoRelativePath);
        }
      }
      const newlyOwnedPaths = repoRelative.filter(
        (repoRelativePath) => !alreadyOwnedPaths.includes(repoRelativePath),
      );
      const viteTrackablePaths = newlyOwnedPaths.filter(isViteTrackablePath);
      await trackPaths(viteTrackablePaths);
      if (tracker.getRunStatus(runId) !== "active") {
        const unownedPaths = viteTrackablePaths.filter(
          (repoRelativePath) => tracker.getOwners(repoRelativePath).length === 0,
        );
        await untrackPaths(unownedPaths);
        return;
      }
      tracker.recordWrite(runId, newlyOwnedPaths);
      if (touchedPaths && tracker.getRunStatus(runId) === "active") {
        for (const repoRelativePath of newlyOwnedPaths) {
          touchedPaths.add(repoRelativePath);
          if (captureSnapshot) {
            snapshotPathForRun(runId, repoRelativePath);
          }
        }
      }
    },

    finalize(runId) {
      snapshotRun(runId);
      const decision = tracker.finalize(runId);
      const result = finishApplyResult(decision);
      if (!tracker.hasRun(runId)) {
        touchedPathsByRun.delete(runId);
        if (result.appliedRuns.every((run) => run.runId !== runId)) {
          finalizedSnapshotsByRun.delete(runId);
        }
      }
      return result;
    },

    async cancel(runId) {
      dropRunState([runId]);
      const decision = tracker.cancel(runId);
      const result = finishApplyResult(decision);
      if (decision.releasedPaths.length > 0) {
        await untrackPaths(decision.releasedPaths);
      }
      await releaseClientUpdates([runId]);
      return { ...result, releasedPaths: [...decision.releasedPaths] };
    },

    async apply(appliedRuns, applyOptions) {
      if (appliedRuns.length === 0) return true;
      if (!options.enabled) return true;
      return await sendApply(appliedRuns, applyOptions);
    },

    async discard(appliedRuns) {
      return await sendDiscard(appliedRuns);
    },

    async releaseRuns(runIds) {
      return await releaseClientUpdates(runIds);
    },

    async beginShellMutationGuard() {
      return await postGuard(`${HMR_ENDPOINT_BASE}/begin-shell-mutation`);
    },

    async endShellMutationGuard() {
      return await postGuard(`${HMR_ENDPOINT_BASE}/end-shell-mutation`);
    },

    async forceResumeAll() {
      // Drop tracker state in-process. We don't iterate runs because callers
      // use this on bootstrap when no real runs exist anyway; any leftover
      // state from a prior crashed worker is irrelevant.
      const heldOrActiveRunIds = [
        ...tracker.getActiveRunIds(),
        ...tracker.getHeldRunIds(),
      ];
      for (const runId of heldOrActiveRunIds) {
        tracker.cancel(runId);
      }
      touchedPathsByRun.clear();
      finalizedSnapshotsByRun.clear();
      if (!options.enabled) return true;
      return await postWithRetry({
        getDevServerUrl: options.getDevServerUrl,
        path: `${HMR_ENDPOINT_BASE}/force-resume`,
        maxWaitMs: APPLY_MAX_WAIT_MS,
        authToken: options.authToken,
      });
    },

    async getStatus() {
      if (!options.enabled) {
        return {
          paused:
            tracker.getActiveRunIds().length + tracker.getHeldRunIds().length >
            0,
          inFlightPaths: 0,
          appliedOverlayPaths: 0,
        };
      }
      const baseUrl = options.getDevServerUrl().replace(/\/+$/, "");
      const target = `${baseUrl}${HMR_ENDPOINT_BASE}/status`;
      try {
        const response = await fetch(target, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...(options.authToken
              ? { "X-Stella-Self-Mod-Hmr-Token": options.authToken }
              : {}),
          },
          signal: withTimeoutSignal(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as Partial<HmrStatus>;
        return {
          paused: Boolean(payload.paused),
          inFlightPaths: Number(payload.inFlightPaths ?? 0),
          appliedOverlayPaths: Number(payload.appliedOverlayPaths ?? 0),
        };
      } catch {
        return null;
      }
    },

    hasRun(runId) {
      return tracker.hasRun(runId);
    },

    getRunStatus(runId) {
      return tracker.getRunStatus(runId);
    },

    __tracker: tracker,
  };
};
