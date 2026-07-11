/**
 * Worker-side self-mod apply orchestration.
 *
 * Owns the morph-cover pipeline between the runtime kernel's
 * `SelfModHmrController` (per-run path contention + Vite overlay) and
 * the Electron host:
 *
 *   - `lifecycle` (begin/finalize/cancel) is handed to the runner as
 *     `selfModLifecycle`; finalize commits through `StoreModService`
 *     and stashes the apply batch behind the pending "Update" card.
 *   - `externalLifecycle` wraps non-agent mutations (store git imports,
 *     source imports, desktop updates) in the same begin/record/finish
 *     envelope.
 *   - `dispatchApplyBatch` raises the morph cover on the host
 *     (HOST_HMR_RUN_TRANSITION) and `resumeTransition` (the host's
 *     INTERNAL_WORKER_RESUME_HMR callback) runs the actual Vite apply
 *     once the cover is on screen.
 *   - `revertWithMorph` / `applyPendingWithMorph` are the user-facing
 *     undo / "Update" entry points.
 *
 * All worker-state access is via accessors so a re-init (new
 * StoreModService / controller instance) is picked up without
 * re-wiring; the pending-apply and run-id maps live here.
 */
import crypto from "node:crypto";
import path from "node:path";
import {
  METHOD_NAMES,
  type RuntimeSelfModApplyResult,
  type RuntimeSelfModRevertResult,
} from "../protocol/index.js";
import {
  deriveApplyTransitionRequirements,
  type ApplyOptions,
  type ApplyResult,
  type HmrApplyResponse,
  type SelfModHmrController,
} from "../kernel/self-mod/hmr.js";
import type {
  CommitMessageProvider,
  StoreModService,
} from "../kernel/self-mod/store-mod-service.js";
import type { MediatedWriteCapture } from "../kernel/self-mod/logical-change-set.js";
import {
  getLastSelfModCommitHash,
  listFilesForCommit,
} from "../kernel/self-mod/git/log.js";
import { revertSelfModCommit } from "../kernel/self-mod/git/revert.js";
import type { RuntimeStore } from "../kernel/storage/runtime-store.js";
import type { WorkerPeerLike } from "./peer-broker.js";

export type PendingSelfModApply = {
  commitHash: string;
  changeSetId: string;
  runId: string;
  applyResult: ApplyResult;
  conversationId: string;
  files: string[];
  assistantMessageEventId?: string;
};

/**
 * Per-transition state for an apply batch that the worker has handed to the
 * Electron host to wrap in a morph cover. The host calls back via
 * `INTERNAL_WORKER_RESUME_HMR` once the cover is on screen; we look up the
 * batch by transitionId and run the actual `selfModHmrController.apply`
 * + runtime-reload release at that point so the renderer never visibly
 * crosses the swap.
 */
type PendingApplyBatch = {
  applyResult: ApplyResult;
  requiresFullReload: boolean;
  requiresRuntimeRestart: boolean;
  requiresProcessRestart: boolean;
};

export type ResumeTransitionResult =
  | { ok: true; requiresClientFullReload: boolean }
  | { ok: false; reason: "unknown-transition" | "apply-failed" };

type SelfModApplyMode =
  | "author"
  | "install"
  | "update"
  | "uninstall"
  | "desktop-update";

export type SelfModLifecycle = {
  beginRun: (args: {
    runId: string;
    rootRunId?: string;
    taskDescription: string;
    taskPrompt: string;
    conversationId: string;
    packageId?: string;
    releaseNumber?: number;
    mode?: SelfModApplyMode;
  }) => Promise<void>;
  finalizeRun: (args: {
    runId: string;
    rootRunId?: string;
    taskDescription: string;
    taskPrompt: string;
    conversationId: string;
    threadKey?: string;
    featureId?: string;
    featureTitle?: string;
    succeeded: boolean;
    commitMessageProvider?: CommitMessageProvider;
  }) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  beginMediatedWrite: (args: {
    runId: string;
    paths: string[];
    captureAll?: boolean;
  }) => Promise<MediatedWriteCapture | null>;
  finishMediatedWrite: (args: {
    capture: MediatedWriteCapture | null;
    additionalPaths?: string[];
  }) => Promise<void>;
};

export type ExternalSelfModLifecycle = {
  beginExternalSelfMod: (args: {
    runId: string;
    paths: string[];
  }) => Promise<{ ok: true }>;
  finishExternalSelfMod: (args: {
    runId: string;
    succeeded: boolean;
  }) => Promise<{ ok: true; transitioned: boolean }>;
};

export type SelfModCoordinator = {
  lifecycle: SelfModLifecycle;
  externalLifecycle: ExternalSelfModLifecycle;
  revertWithMorph: (args: {
    commitHash?: string;
    steps?: number;
  }) => Promise<RuntimeSelfModRevertResult>;
  applyPendingWithMorph: (args: {
    commitHash?: string;
  }) => Promise<RuntimeSelfModApplyResult>;
  applyAllPendingWithMorph: () => Promise<RuntimeSelfModApplyResult[]>;
  resumeTransition: (payload: {
    transitionId?: string;
    runIds?: string[];
    options?: ApplyOptions;
  }) => Promise<ResumeTransitionResult>;
  /** Drop all pending apply batches and release their reload pauses. */
  releasePendingApplyBatches: (reason: string) => Promise<void>;
  hasPendingApplyBatches: () => boolean;
};

export type SelfModCoordinatorDeps = {
  peer: WorkerPeerLike;
  getController: () => SelfModHmrController | null;
  getStoreModService: () => StoreModService | null;
  getRuntimeStore: () => RuntimeStore | null;
  getRepoRoot: () => string | null;
  getPendingSelfModApplies: () => Map<string, PendingSelfModApply>;
  patchSelfModApplyStatus: (args: {
    conversationId: string;
    eventId?: string;
    commitHash: string;
    status: "pending" | "applied";
    replacementCommitHash?: string;
  }) => void;
};

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const recordSelfModRevertNotice = (args: {
  runtimeStore: RuntimeStore | null;
  conversationId?: string | null;
  originThreadKey?: string | null;
  commitHash: string;
  files?: string[];
  logScope: string;
}) => {
  const conversationId = asTrimmedString(args.conversationId);
  if (!conversationId || !args.runtimeStore) return;
  try {
    args.runtimeStore.recordSelfModRevert({
      conversationId,
      originThreadKey: args.originThreadKey ?? null,
      commitHash: args.commitHash,
      files: args.files ?? [],
    });
  } catch (error) {
    console.warn(
      `[${args.logScope}] failed to record revert notice:`,
      (error as Error).message,
    );
  }
};

export const createSelfModCoordinator = (
  deps: SelfModCoordinatorDeps,
): SelfModCoordinator => {
  const {
    peer,
    getController,
    getStoreModService,
    getRuntimeStore,
    getRepoRoot,
    getPendingSelfModApplies,
    patchSelfModApplyStatus,
  } = deps;

  const pendingApplyBatches = new Map<string, PendingApplyBatch>();
  const selfModRunRootIds = new Map<string, string>();
  const selfModRunApplyModes = new Map<string, string | undefined>();
  const externalSelfModPathsByRun = new Map<string, string[]>();
  const transitionedRunIds = new Set<string>();

  const rememberTransitionedRuns = (runIds: string[]) => {
    for (const runId of runIds) transitionedRunIds.add(runId);
    while (transitionedRunIds.size > 256) {
      const oldest = transitionedRunIds.values().next().value;
      if (typeof oldest !== "string") break;
      transitionedRunIds.delete(oldest);
    }
  };

  const releaseRuntimeReloadFor = async (
    runIds: string[],
    options?: { allowDeferredReload?: boolean },
  ) => {
    await Promise.all(
      runIds.map(async (runId) => {
        try {
          await peer.request(
            METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME,
            {
              runId,
              allowDeferredReload: options?.allowDeferredReload !== false,
            },
            { retryOnDisconnect: true },
          );
        } catch (error) {
          console.warn(
            "[self-mod-reload] Failed to resume host runtime reloads:",
            (error as Error).message,
          );
        }
      }),
    );
  };

  const releasePendingApplyBatches = async (reason: string) => {
    const runIds = [
      ...new Set(
        [...pendingApplyBatches.values()].flatMap(
          (pending) => pending.applyResult.restartRelevantRunIds,
        ),
      ),
    ];
    pendingApplyBatches.clear();
    selfModRunRootIds.clear();
    selfModRunApplyModes.clear();
    if (runIds.length === 0) return;
    console.warn(
      `[self-mod-hmr] Releasing runtime reload pauses for pending apply batches: ${reason}.`,
    );
    await releaseRuntimeReloadFor(runIds);
  };

  const discardFailedApplyState = async (
    applyResult: ApplyResult,
    reason: string,
  ) => {
    const controller = getController();
    if (!controller) return;
    const discarded = await controller
      .discard(applyResult.appliedRuns)
      .catch((error) => {
        console.warn(
          `[self-mod-hmr] Failed to discard Vite self-mod state after ${reason}:`,
          (error as Error).message,
        );
        return false;
      });
    if (!discarded) {
      console.warn(
        `[self-mod-hmr] Vite self-mod state may remain pinned after ${reason}.`,
      );
    }
    await controller
      .releaseRuns(applyResult.restartRelevantRunIds)
      .catch((error) => {
        console.warn(
          `[self-mod-hmr] Failed to release Vite client update pauses after ${reason}:`,
          (error as Error).message,
        );
      });
  };

  const dropRunBookkeeping = (runIds: Iterable<string>) => {
    for (const runId of runIds) {
      selfModRunRootIds.delete(runId);
      selfModRunApplyModes.delete(runId);
    }
  };

  // The worker server owns morph orchestration: each finalize/cancel that
  // produces an apply batch flows through `dispatchApplyBatch`, which
  // raises the morph cover on the host (HOST_HMR_RUN_TRANSITION) and
  // waits for the host's INTERNAL_WORKER_RESUME_HMR callback before
  // running the actual `selfModHmrController.apply` and releasing the
  // per-runId runtime-reload pauses.
  const dispatchApplyBatch = async (applyResult: ApplyResult) => {
    if (applyResult.appliedRuns.length === 0) {
      return;
    }
    const transitionId = crypto.randomUUID();
    const stateRunIds = [
      ...new Set(
        applyResult.restartRelevantRunIds.map(
          (runId) => selfModRunRootIds.get(runId) ?? runId,
        ),
      ),
    ];
    const {
      requiresFullReload,
      requiresRuntimeRestart,
      requiresProcessRestart,
    } = deriveApplyTransitionRequirements(applyResult);
    pendingApplyBatches.set(transitionId, {
      applyResult,
      requiresFullReload,
      requiresRuntimeRestart,
      requiresProcessRestart,
    });
    try {
      await peer.request(
        METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
        {
          transitionId,
          runIds: applyResult.restartRelevantRunIds,
          stateRunIds,
          requiresFullReload,
          requiresRuntimeRestart,
          requiresProcessRestart,
        },
        { retryOnDisconnect: true },
      );
      rememberTransitionedRuns(applyResult.restartRelevantRunIds);
    } catch (error) {
      console.warn(
        "[self-mod-hmr] HOST_HMR_RUN_TRANSITION failed; applying without morph cover:",
        (error as Error).message,
      );
      // Host couldn't drive the cover (no Electron, or shutting down). Try
      // the apply directly, but only release runtime-reload pauses after
      // Vite confirms it accepted the overlay update.
      if (pendingApplyBatches.has(transitionId)) {
        const controller = getController();
        const applyResponse: HmrApplyResponse = controller
          ? await controller
              .apply(applyResult.appliedRuns, {
                forceClientFullReload: true,
              })
              .catch(() => ({ ok: false }))
          : { ok: true };
        if (!applyResponse.ok) {
          console.warn(
            "[self-mod-hmr] Direct apply failed; discarding Vite self-mod state before releasing runtime reload pause.",
          );
          await discardFailedApplyState(applyResult, "direct apply failure");
        }
        pendingApplyBatches.delete(transitionId);
        await releaseRuntimeReloadFor(applyResult.restartRelevantRunIds, {
          allowDeferredReload: requiresRuntimeRestart,
        });
        dropRunBookkeeping(applyResult.restartRelevantRunIds);
      }
    }
  };

  const releaseRunCompletely = async (runId: string, logScope: string) => {
    const controller = getController();
    await controller?.releaseRuns([runId]).catch((error) => {
      console.warn(
        `[${logScope}] Failed to release Vite client update pause:`,
        (error as Error).message,
      );
    });
    await releaseRuntimeReloadFor([runId]);
    dropRunBookkeeping([runId]);
  };

  const lifecycle: SelfModLifecycle = {
    beginRun: async ({
      runId,
      rootRunId,
      taskDescription,
      packageId,
      releaseNumber,
      mode,
    }) => {
      selfModRunRootIds.set(runId, rootRunId ?? runId);
      selfModRunApplyModes.set(runId, mode);
      await peer
        .request(METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE, {
          runId,
        })
        .catch((error) => {
          console.warn(
            "[self-mod-reload] Failed to pause host runtime reloads:",
            (error as Error).message,
          );
        });
      const storeModService = getStoreModService();
      if (!storeModService) {
        throw new Error("Store mod service is not available.");
      }
      await storeModService.beginSelfModRun({
        runId,
        taskDescription,
        ...(packageId ? { packageId } : {}),
        ...(releaseNumber == null ? {} : { releaseNumber }),
        ...(mode ? { applyMode: mode } : {}),
      });
    },

    finalizeRun: async ({
      runId,
      succeeded,
      conversationId,
      threadKey,
      featureId,
      featureTitle,
      commitMessageProvider,
    }) => {
      const storeModService = getStoreModService();
      const controller = getController();
      // Git commit happens BEFORE the apply so the overlay's
      // "read from disk at apply time" sees the post-commit content.
      // (For most cases the disk hasn't moved between write and
      // commit, but this ordering is cheaper to reason about than
      // racing them.)
      const finalized = await storeModService?.finalizeSelfModRun({
        runId,
        succeeded,
        ...(conversationId ? { conversationId } : {}),
        ...(threadKey ? { threadKey } : {}),
        ...(featureId ? { featureId } : {}),
        ...(featureTitle ? { featureTitle } : {}),
        ...(commitMessageProvider ? { commitMessageProvider } : {}),
        ...(controller
          ? {
              isPathOwnedByAnotherActiveRun: (repoRelativePath: string) =>
                controller.isPathOwnedByAnotherActiveRun(
                  repoRelativePath,
                  runId,
                ),
            }
          : {}),
      });

      if (!controller || !controller.hasRun(runId)) {
        // Run was never registered with the contention tracker
        // (e.g., the orchestrator skipped tracking for this run).
        // Nothing to apply — just release the reload pause that
        // beginRun installed.
        await releaseRunCompletely(runId, "self-mod-hmr");
        return;
      }

      const applyMode = selfModRunApplyModes.get(runId);
      const decision =
        applyMode === "author"
          ? controller.finalizeIsolated(runId)
          : controller.finalize(runId);
      if (decision.appliedRuns.length === 0) {
        if (!controller.hasRun(runId)) {
          // The run finalized with no tracked source writes. There is
          // no renderer batch to apply, but beginRun still installed a
          // runtime-reload pause that must be released.
          await releaseRunCompletely(runId, "self-mod-hmr");
          return;
        }
        // Run is held — another active run still owns at least one
        // touched path. Reload pause stays in place; it'll be
        // released once the held batch finally drains and applies.
        return;
      }
      // Author runs defer the apply: the user applies by clicking
      // "Update" on the pending card. The card is matched back to this
      // stash in `onEnd` by commit hash (reliable; no run-id correlation
      // needed). A change that never gets clicked stays committed on
      // disk and goes live on the next restart. Every other mode
      // (install/update/uninstall/desktop-update) has no chat surface
      // to host a card — their conversations are background threads —
      // so they auto-apply under the morph cover instead.
      if (finalized?.commitHash && applyMode === "author") {
        getPendingSelfModApplies().set(finalized.commitHash, {
          commitHash: finalized.commitHash,
          changeSetId: finalized.commitHash,
          runId,
          applyResult: decision,
          conversationId: conversationId ?? "",
          files: finalized.files,
        });
        return;
      }
      await dispatchApplyBatch(decision);
    },

    cancelRun: async (runId) => {
      getStoreModService()?.cancelSelfModRun(runId);

      const controller = getController();
      if (!controller || !controller.hasRun(runId)) {
        await releaseRunCompletely(runId, "self-mod-hmr");
        return;
      }

      // Cancel may drain held runs whose only blocker was this one.
      // Apply the drained batch under a morph cover, then release
      // this run's pause separately (cancel is not part of the apply
      // batch — it discards its writes rather than apply them).
      const cancelResult = await controller.cancel(runId);
      await releaseRuntimeReloadFor([runId]);
      dropRunBookkeeping([runId]);
      await dispatchApplyBatch(cancelResult);
    },

    beginMediatedWrite: async ({ runId, paths, captureAll }) =>
      (await getStoreModService()?.beginMediatedWrite(runId, paths, {
        captureAll,
      })) ?? null,

    finishMediatedWrite: async ({ capture, additionalPaths }) => {
      await getStoreModService()?.finishMediatedWrite(
        capture,
        additionalPaths ?? [],
      );
    },
  };

  const externalLifecycle: ExternalSelfModLifecycle = {
    beginExternalSelfMod: async ({ runId, paths }) => {
      const controller = getController();
      if (!controller) {
        throw new Error("Self-mod HMR controller is not initialized.");
      }
      const repoRoot = getRepoRoot();
      if (!repoRoot) {
        throw new Error("Worker has not been initialized.");
      }
      selfModRunRootIds.set(runId, runId);
      await peer
        .request(METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE, { runId })
        .catch((error) => {
          console.warn(
            "[self-mod-external] Failed to pause host runtime reloads:",
            (error as Error).message,
          );
        });
      try {
        await controller.beginRun(runId);
        const absolutePaths = paths.map((filePath) =>
          path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath),
        );
        if (absolutePaths.length > 0) {
          externalSelfModPathsByRun.set(runId, absolutePaths);
          // Match agent self-mod pre-write tracking: own/pin the paths now,
          // but capture the morph payload only after the external mutation.
          await controller.recordWrite(runId, absolutePaths, {
            captureSnapshot: false,
          });
        }
        return { ok: true };
      } catch (error) {
        if (controller.hasRun(runId)) {
          await controller.cancel(runId).catch(() => undefined);
        }
        await releaseRuntimeReloadFor([runId]);
        dropRunBookkeeping([runId]);
        externalSelfModPathsByRun.delete(runId);
        throw error;
      }
    },

    finishExternalSelfMod: async ({ runId, succeeded }) => {
      const controller = getController();
      if (!controller) {
        throw new Error("Self-mod HMR controller is not initialized.");
      }
      if (!controller.hasRun(runId)) {
        const transitioned = transitionedRunIds.has(runId);
        await releaseRunCompletely(runId, "self-mod-external");
        externalSelfModPathsByRun.delete(runId);
        return { ok: true, transitioned };
      }

      if (!succeeded) {
        const cancelResult = await controller.cancel(runId);
        await releaseRuntimeReloadFor([runId]);
        dropRunBookkeeping([runId]);
        externalSelfModPathsByRun.delete(runId);
        await dispatchApplyBatch(cancelResult);
        return { ok: true, transitioned: false };
      }

      const absolutePaths = externalSelfModPathsByRun.get(runId) ?? [];
      if (absolutePaths.length > 0) {
        // Capture the post-merge contents so the morph overlay cannot replay
        // stale pre-update files over the freshly merged checkout.
        await controller.recordWrite(runId, absolutePaths);
      }
      const decision = controller.finalize(runId);
      externalSelfModPathsByRun.delete(runId);
      if (decision.appliedRuns.length === 0) {
        if (!controller.hasRun(runId)) {
          await releaseRunCompletely(runId, "self-mod-external");
        }
        return { ok: true, transitioned: transitionedRunIds.has(runId) };
      }

      await dispatchApplyBatch(decision);
      return { ok: true, transitioned: transitionedRunIds.has(runId) };
    },
  };

  const revertWithMorph = async (payload: {
    commitHash?: string;
    steps?: number;
  }): Promise<RuntimeSelfModRevertResult> => {
    const repoRoot = getRepoRoot();
    if (!repoRoot) {
      throw new Error("Worker has not been initialized.");
    }
    const controller = getController();
    if (!controller) {
      // Worker initialized without HMR wiring (test fixtures, e.g.).
      // Fall back to the raw revert with no morph cover — better than
      // refusing the user's undo entirely.
      const result = await revertSelfModCommit({
        repoRoot,
        commitHash: payload.commitHash,
        steps: payload.steps,
      });
      recordSelfModRevertNotice({
        runtimeStore: getRuntimeStore(),
        conversationId: result.conversationId,
        originThreadKey: result.originThreadKey,
        commitHash: result.commitHash,
        files: result.files,
        logScope: "self-mod-revert",
      });
      return result;
    }

    const syntheticRunId = `self-mod-revert:${crypto.randomUUID()}`;
    let runRegisteredWithHmr = false;
    let runtimeReloadPaused = false;

    // Resolve the target commit hash ONCE up front. Both
    // `listFilesForCommit` (snapshot) and `revertSelfModCommit` (the
    // actual revert) fall back to the latest self-mod commit when no
    // hash is supplied; resolving here pins both calls to the same
    // commit in the common case. Edge case: when no self-mod commit
    // exists yet, `resolvedCommitHash` collapses back to `undefined`
    // and `revertSelfModCommit` throws cleanly with "No commit found
    // to revert".
    const resolvedCommitHash =
      payload.commitHash?.trim() ||
      (await getLastSelfModCommitHash(repoRoot).catch(() => null)) ||
      undefined;

    try {
      selfModRunRootIds.set(syntheticRunId, syntheticRunId);
      await peer
        .request(METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE, {
          runId: syntheticRunId,
        })
        .then(() => {
          runtimeReloadPaused = true;
        })
        .catch((error) => {
          console.warn(
            "[self-mod-revert] Failed to pause host runtime reloads:",
            (error as Error).message,
          );
        });
      await controller.beginRun(syntheticRunId);
      runRegisteredWithHmr = true;

      // Snapshot pre-revert disk content for every file the revert
      // will touch. Vite serves the snapshot until apply, then
      // cross-fades into the reverted (live disk) content under the
      // morph cover.
      let preRevertFiles: string[] = [];
      try {
        preRevertFiles = await listFilesForCommit(
          repoRoot,
          resolvedCommitHash ?? null,
        );
      } catch {
        // Best-effort — without it Vite still reacts via its watcher
        // post-revert, just without a morph cover.
      }
      if (preRevertFiles.length > 0) {
        const absolutePaths = preRevertFiles.map((file) =>
          path.join(repoRoot, file),
        );
        await controller.recordWrite(syntheticRunId, absolutePaths);
      }

      const result = await revertSelfModCommit({
        repoRoot,
        commitHash: resolvedCommitHash,
        steps: payload.steps,
      });

      // Ledger the revert so the revert-notice hook can inject on
      // the next user turn for orchestrator + originating subagent.
      // Skipped when the commit had no `Stella-Conversation`
      // trailer — without it, we have no conversation to route to.
      recordSelfModRevertNotice({
        runtimeStore: getRuntimeStore(),
        conversationId: result.conversationId,
        originThreadKey: result.originThreadKey,
        commitHash: result.commitHash,
        files: result.files,
        logScope: "self-mod-revert",
      });

      // Finalize through the shared apply pipeline — same code path
      // an agent self-mod run takes. Handles HMR vs full reload vs
      // worker restart based on path-relevance classification of the
      // files we just snapshotted.
      const decision = controller.finalize(syntheticRunId);
      runRegisteredWithHmr = false;
      if (decision.appliedRuns.length === 0) {
        await controller.releaseRuns([syntheticRunId]).catch((error) => {
          console.warn(
            "[self-mod-revert] Failed to release Vite client update pause:",
            (error as Error).message,
          );
        });
        if (runtimeReloadPaused) {
          await releaseRuntimeReloadFor([syntheticRunId]);
          runtimeReloadPaused = false;
        }
        selfModRunRootIds.delete(syntheticRunId);
      } else {
        await dispatchApplyBatch(decision);
        // dispatchApplyBatch owns the apply + runtime-reload release
        // for `decision.restartRelevantRunIds`. Anything not in that
        // set still needs its pause released here.
        if (
          runtimeReloadPaused &&
          !decision.restartRelevantRunIds.includes(syntheticRunId)
        ) {
          await releaseRuntimeReloadFor([syntheticRunId]);
          runtimeReloadPaused = false;
        }
        if (!decision.restartRelevantRunIds.includes(syntheticRunId)) {
          selfModRunRootIds.delete(syntheticRunId);
        }
      }

      return result;
    } catch (err) {
      if (runRegisteredWithHmr) {
        await controller.releaseRuns([syntheticRunId]).catch(() => undefined);
      }
      if (runtimeReloadPaused) {
        await releaseRuntimeReloadFor([syntheticRunId]).catch(() => undefined);
      }
      selfModRunRootIds.delete(syntheticRunId);
      throw err;
    }
  };

  const applyPendingWithMorph = async ({
    commitHash,
  }: {
    commitHash?: string;
  }): Promise<RuntimeSelfModApplyResult> => {
    const resolvedCommitHash = commitHash?.trim();
    if (!resolvedCommitHash) {
      throw new Error("Self-mod commit hash is required.");
    }
    if (!getRepoRoot()) {
      throw new Error("Worker has not been initialized.");
    }
    const pendingSelfModApplies = getPendingSelfModApplies();
    const entry = pendingSelfModApplies.get(resolvedCommitHash);

    if (!entry) {
      return {
        commitHash: resolvedCommitHash,
        applied: false,
        message: "Pending self-mod apply was not found.",
      };
    }
    const prepared =
      await getStoreModService()?.applyPreparedAuthorChange(resolvedCommitHash);
    if (!prepared) {
      return {
        commitHash: resolvedCommitHash,
        applied: false,
        message: "Pending logical self-mod change set was not found.",
      };
    }
    if (prepared.status === "conflicts") {
      return {
        commitHash: resolvedCommitHash,
        applied: false,
        message: "Self-mod apply requires conflict resolution.",
        conflicts: prepared.conflicts,
      };
    }
    pendingSelfModApplies.delete(entry.commitHash);
    const mergedByPath = new Map(
      prepared.files.map((file) => [file.path, file]),
    );
    const selectedApplyResult: ApplyResult = {
      ...entry.applyResult,
      appliedRuns: entry.applyResult.appliedRuns.map((run) => ({
        ...run,
        files: run.paths.flatMap((filePath) => {
          const file = mergedByPath.get(filePath);
          return file ? [file] : [];
        }),
      })),
    };
    if (prepared.files.length > 0) {
      await dispatchApplyBatch(selectedApplyResult);
    } else {
      await releaseRuntimeReloadFor(entry.applyResult.restartRelevantRunIds);
      dropRunBookkeeping(entry.applyResult.restartRelevantRunIds);
    }
    patchSelfModApplyStatus({
      conversationId: entry.conversationId,
      eventId: entry.assistantMessageEventId,
      commitHash: entry.commitHash,
      replacementCommitHash: prepared.commitHash ?? undefined,
      status: "applied",
    });
    return {
      commitHash: prepared.commitHash ?? resolvedCommitHash,
      applied: true,
    };
  };

  const resumeTransition = async (payload: {
    transitionId?: string;
    runIds?: string[];
    options?: ApplyOptions;
  }): Promise<ResumeTransitionResult> => {
    // The host's signal that the morph cover for `transitionId` is on
    // screen and we can safely run the actual overlay apply + release
    // the runtime-reload pauses.
    const transitionId = payload?.transitionId?.trim();
    if (!transitionId) {
      throw new Error("INTERNAL_WORKER_RESUME_HMR requires a transitionId.");
    }
    const pending = pendingApplyBatches.get(transitionId);
    if (!pending) {
      // Stale callback (e.g., worker restarted between dispatch and
      // resume). Release the host-side runtime reload pauses using the
      // runIds echoed back by the host; the worker's pending map may have
      // been lost while the host kept its pause set alive.
      const staleRunIds = Array.isArray(payload?.runIds)
        ? payload.runIds.filter((runId) => typeof runId === "string")
        : [];
      await releaseRuntimeReloadFor(staleRunIds);
      return { ok: false, reason: "unknown-transition" };
    }
    const controller = getController();
    if (pending.requiresProcessRestart) {
      const discarded = controller
        ? await controller.discard(pending.applyResult.appliedRuns)
        : false;
      if (!discarded) {
        console.warn(
          "[self-mod-hmr] Failed to discard Vite state before process restart.",
        );
      }
      pendingApplyBatches.delete(transitionId);
      await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
        allowDeferredReload: false,
      });
      dropRunBookkeeping(pending.applyResult.restartRelevantRunIds);
      return { ok: true, requiresClientFullReload: false };
    }

    let applyResponse: HmrApplyResponse = controller
      ? await controller
          .apply(pending.applyResult.appliedRuns, payload?.options)
          .catch(() => ({ ok: false }))
      : { ok: false };
    if (
      !applyResponse.ok &&
      controller &&
      payload?.options?.forceClientFullReload !== true
    ) {
      applyResponse = await controller
        .apply(pending.applyResult.appliedRuns, {
          forceClientFullReload: true,
        })
        .catch(() => ({ ok: false }));
      if (applyResponse.ok) {
        applyResponse = {
          ...applyResponse,
          requiresClientFullReload: true,
        };
      }
    }
    if (!applyResponse.ok) {
      console.warn(
        "[self-mod-hmr] Apply failed; discarding Vite self-mod state before releasing runtime reload pause.",
      );
      await discardFailedApplyState(pending.applyResult, "apply failure");
      pendingApplyBatches.delete(transitionId);
      await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
        allowDeferredReload: pending.requiresRuntimeRestart,
      });
      dropRunBookkeeping(pending.applyResult.restartRelevantRunIds);
      return { ok: false, reason: "apply-failed" };
    }
    pendingApplyBatches.delete(transitionId);
    await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
      allowDeferredReload: pending.requiresRuntimeRestart,
    });
    dropRunBookkeeping(pending.applyResult.restartRelevantRunIds);
    return {
      ok: true,
      requiresClientFullReload: applyResponse.requiresClientFullReload === true,
    };
  };

  return {
    lifecycle,
    externalLifecycle,
    revertWithMorph,
    applyPendingWithMorph,
    applyAllPendingWithMorph: async () => {
      const selectors = [...getPendingSelfModApplies().keys()];
      const results: RuntimeSelfModApplyResult[] = [];
      for (const selector of selectors) {
        results.push(await applyPendingWithMorph({ commitHash: selector }));
      }
      return results;
    },
    resumeTransition,
    releasePendingApplyBatches,
    hasPendingApplyBatches: () => pendingApplyBatches.size > 0,
  };
};
