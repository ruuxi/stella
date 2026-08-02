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
  type RuntimeSelfModRevertRequest,
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
import {
  getLastSelfModCommitHash,
  listFilesForCommit,
  listGitCommitsBySelector,
} from "../kernel/self-mod/git/log.js";
import {
  revertSelfModCommit,
  revertSelfModCommits,
} from "../kernel/self-mod/git/revert.js";
import type { RuntimeStore } from "../kernel/storage/runtime-store.js";
import type {
  PersistedPendingSelfModApply,
  SelfModPendingStore,
} from "../kernel/storage/self-mod-pending-store.js";
import type { WorkerPeerLike } from "./peer-broker.js";

export type PendingSelfModApply = PersistedPendingSelfModApply;

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
  settleApplied: () => void;
  settleFailed: () => void;
};

type ApplyBatchSettlement = {
  onApplied?: () => void;
  onFailed?: () => void;
};

type FinalizedAuthorContribution = {
  commitHash?: string;
  conversationId: string;
  files: string[];
  ownerThreadId?: string;
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
    /** Top-level General thread whose terminal final publishes this contribution. */
    ownerThreadId?: string;
    featureId?: string;
    featureTitle?: string;
    succeeded: boolean;
    commitMessageProvider?: CommitMessageProvider;
  }) => Promise<void>;
  publishCompletion: (args: {
    conversationId: string;
    ownerThreadId: string;
    completionEventId: string;
  }) => Promise<{
    changeSetId?: string;
    contributionCount: number;
  }>;
  cancelRun: (runId: string) => Promise<void>;
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
  revertWithMorph: (
    args: RuntimeSelfModRevertRequest,
  ) => Promise<RuntimeSelfModRevertResult>;
  applyPendingWithMorph: (args: {
    applyId?: string;
    commitHash?: string;
  }) => Promise<RuntimeSelfModApplyResult>;
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
  /** Keyed by `applyId` (the self-mod run id), in finalize order. */
  getPendingSelfModApplies: () => Map<string, PendingSelfModApply>;
  /** Durable source of truth; omitted only by isolated unit-test fixtures. */
  getPendingSelfModStore?: () => SelfModPendingStore | null;
  patchSelfModApplyStatus: (args: {
    conversationId: string;
    eventId?: string;
    applyId?: string;
    commitHash?: string;
    status: "pending" | "applied" | "reverted";
  }) => void;
};

// Combine several deferred apply batches into a single transition so a
// cumulative "Update" raises one morph cover and triggers one worker restart
// (rather than one per pending change). `results` must be in commit order:
// later entries' runs apply last, so they win for any overlapping path.
const mergePendingApplyResults = (results: ApplyResult[]): ApplyResult => ({
  appliedRuns: results.flatMap((result) => result.appliedRuns),
  restartRelevantRunIds: [
    ...new Set(results.flatMap((result) => result.restartRelevantRunIds)),
  ],
  hasRestartRelevantPaths: results.some(
    (result) => result.hasRestartRelevantPaths,
  ),
  hasRuntimeRestartRelevantPaths: results.some(
    (result) => result.hasRuntimeRestartRelevantPaths,
  ),
  hasProcessRestartRelevantPaths: results.some(
    (result) => result.hasProcessRestartRelevantPaths,
  ),
  hasFullReloadRelevantPaths: results.some(
    (result) => result.hasFullReloadRelevantPaths,
  ),
});

const selectAppliedRuns = (
  result: ApplyResult,
  runIds: ReadonlySet<string>,
): ApplyResult => {
  const appliedRuns = result.appliedRuns.filter((run) => runIds.has(run.runId));
  return {
    appliedRuns,
    restartRelevantRunIds: appliedRuns.map((run) => run.runId),
    hasRestartRelevantPaths: appliedRuns.some(
      (run) => run.restartRelevantPaths.length > 0,
    ),
    hasRuntimeRestartRelevantPaths: appliedRuns.some(
      (run) => run.runtimeRestartRelevantPaths.length > 0,
    ),
    hasProcessRestartRelevantPaths: appliedRuns.some(
      (run) => run.processRestartRelevantPaths.length > 0,
    ),
    hasFullReloadRelevantPaths: appliedRuns.some(
      (run) => run.fullReloadRelevantPaths.length > 0,
    ),
  };
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
    getPendingSelfModStore,
    patchSelfModApplyStatus,
  } = deps;

  const pendingApplyBatches = new Map<string, PendingApplyBatch>();
  const selfModRunRootIds = new Map<string, string>();
  const selfModRunApplyModes = new Map<string, string | undefined>();
  const finalizedAuthorContributions = new Map<
    string,
    FinalizedAuthorContribution
  >();
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
    finalizedAuthorContributions.clear();
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
      finalizedAuthorContributions.delete(runId);
    }
  };

  /**
   * A contention drain may contain several runs that finalized at different
   * times. Restore each author run to its own contribution before publication
   * instead of assigning the whole batch to whichever run happened to unblock
   * it. Non-author runs stay in the automatic apply batch.
   */
  const stageAuthorContributions = (decision: ApplyResult): ApplyResult => {
    const automaticRunIds = new Set<string>();
    for (const appliedRun of decision.appliedRuns) {
      const finalized = finalizedAuthorContributions.get(appliedRun.runId);
      if (!finalized) {
        automaticRunIds.add(appliedRun.runId);
        continue;
      }
      const applyResult = selectAppliedRuns(
        decision,
        new Set([appliedRun.runId]),
      );
      const contribution: PendingSelfModApply = {
        applyId: appliedRun.runId,
        ...(finalized.commitHash ? { commitHash: finalized.commitHash } : {}),
        applyResult,
        conversationId: finalized.conversationId,
        files:
          finalized.files.length > 0 ? finalized.files : [...appliedRun.paths],
        ...(finalized.ownerThreadId
          ? { ownerThreadId: finalized.ownerThreadId }
          : {}),
      };
      // Persist before exposing the contribution in memory. A crash can leave
      // a durable row without a cache entry (rehydration fixes that), but never
      // an apparently publishable cache entry that restart silently loses.
      const persistedContribution =
        getPendingSelfModStore?.()?.stageContribution(contribution) ??
        contribution;
      getPendingSelfModApplies().set(appliedRun.runId, persistedContribution);
      finalizedAuthorContributions.delete(appliedRun.runId);
    }
    return selectAppliedRuns(decision, automaticRunIds);
  };

  // The worker server owns morph orchestration: each finalize/cancel that
  // produces an apply batch flows through `dispatchApplyBatch`, which
  // raises the morph cover on the host (HOST_HMR_RUN_TRANSITION) and
  // waits for the host's INTERNAL_WORKER_RESUME_HMR callback before
  // running the actual `selfModHmrController.apply` and releasing the
  // per-runId runtime-reload pauses.
  const dispatchApplyBatch = async (
    applyResult: ApplyResult,
    settlement?: ApplyBatchSettlement,
  ): Promise<boolean> => {
    if (applyResult.appliedRuns.length === 0) {
      settlement?.onApplied?.();
      return true;
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
    let settlementState: "applied" | "failed" | null = null;
    const settleApplied = () => {
      if (settlementState) return;
      settlement?.onApplied?.();
      settlementState = "applied";
    };
    const settleFailed = () => {
      if (settlementState) return;
      settlement?.onFailed?.();
      settlementState = "failed";
    };
    pendingApplyBatches.set(transitionId, {
      applyResult,
      requiresFullReload,
      requiresRuntimeRestart,
      requiresProcessRestart,
      settleApplied,
      settleFailed,
    });
    try {
      // The host request is a completion barrier, not an acceptance ACK: its
      // handler awaits the morph transition and the applyBatch callback. The
      // callback durably settles the change set before releasing the runtime
      // pause, so a deferred worker restart cannot race ahead of persistence.
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
      // Production host handlers cannot reach this point with the batch still
      // pending: they await resumeTransition. Lightweight test/CLI peers may
      // acknowledge the request directly, so preserve their historical
      // behavior while keeping the production durability barrier in the
      // resume callback.
      if (pendingApplyBatches.has(transitionId)) {
        settleApplied();
      }
      rememberTransitionedRuns(applyResult.restartRelevantRunIds);
      return true;
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
          settleFailed();
        } else {
          settleApplied();
        }
        pendingApplyBatches.delete(transitionId);
        await releaseRuntimeReloadFor(applyResult.restartRelevantRunIds, {
          allowDeferredReload: requiresRuntimeRestart,
        });
        dropRunBookkeeping(applyResult.restartRelevantRunIds);
        return applyResponse.ok;
      }
      return settlementState === "applied";
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
      ownerThreadId,
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
      if (applyMode === "author") {
        if (!finalized?.commitHash) {
          // Undo resolves through the commit's Stella trailers, so without a
          // commit the card can still apply but will never offer Undo.
          console.warn(
            `[self-mod] Run ${runId} produced no commit; its update card will not offer Undo.`,
          );
        }
        finalizedAuthorContributions.set(runId, {
          ...(finalized?.commitHash
            ? { commitHash: finalized.commitHash }
            : {}),
          conversationId: conversationId ?? "",
          files: finalized?.files ?? [],
          ...(ownerThreadId?.trim()
            ? { ownerThreadId: ownerThreadId.trim() }
            : {}),
        });
      }

      const decision = controller.finalize(runId);
      if (decision.appliedRuns.length === 0) {
        if (!controller.hasRun(runId)) {
          // The run finalized with no tracked source writes. There is
          // no renderer batch to apply, but beginRun still installed a
          // runtime-reload pause that must be released.
          finalizedAuthorContributions.delete(runId);
          await releaseRunCompletely(runId, "self-mod-hmr");
          return;
        }
        // Run is held — another active run still owns at least one
        // touched path. Reload pause stays in place; it'll be
        // released once the held batch finally drains and applies.
        return;
      }
      // Author runs defer their own part of the drained batch: the user applies
      // it from the grouped card. A contention drain can include older held
      // runs, so restore each one from its original finalization metadata.
      const automaticDecision = stageAuthorContributions(decision);
      // Publication is deliberately separate from finalization. A child run
      // finishing must never reach back and mutate whichever root assistant
      // row happened to be latest. Only the owning General's automatic
      // terminal final claims the ready contributions into one stable change
      // set; the matching orchestrator reply may then attach that set.
      // Install/update/uninstall/desktop-update runs have no chat surface and
      // therefore retain automatic HMR behavior even when they drain beside an
      // author contribution.
      await dispatchApplyBatch(automaticDecision);
    },

    publishCompletion: async ({
      conversationId,
      ownerThreadId,
      completionEventId,
    }) => {
      const normalizedConversationId = conversationId.trim();
      const normalizedOwnerThreadId = ownerThreadId.trim();
      const normalizedCompletionEventId = completionEventId.trim();
      if (
        !normalizedConversationId ||
        !normalizedOwnerThreadId ||
        !normalizedCompletionEventId
      ) {
        return { contributionCount: 0 };
      }
      const pendingStore = getPendingSelfModStore?.();
      if (pendingStore) {
        const published = pendingStore.publishCompletion({
          conversationId: normalizedConversationId,
          ownerThreadId: normalizedOwnerThreadId,
          completionEventId: normalizedCompletionEventId,
        });
        const pendingMap = getPendingSelfModApplies();
        for (const contribution of published.contributions) {
          const cached = pendingMap.get(contribution.applyId);
          if (cached) {
            Object.assign(cached, contribution);
          } else {
            pendingMap.set(contribution.applyId, contribution);
          }
        }
        return {
          changeSetId: published.changeSet.changeSetId,
          contributionCount: published.contributions.length,
        };
      }
      const pending = [...getPendingSelfModApplies().values()];
      const alreadyPublished = pending.filter(
        (entry) =>
          entry.conversationId === normalizedConversationId &&
          entry.ownerThreadId === normalizedOwnerThreadId &&
          entry.completionEventId === normalizedCompletionEventId &&
          Boolean(entry.changeSetId),
      );
      if (alreadyPublished.length > 0) {
        return {
          changeSetId: alreadyPublished[0]!.changeSetId,
          contributionCount: alreadyPublished.length,
        };
      }
      const contributions = pending.filter(
        (entry) =>
          entry.conversationId === normalizedConversationId &&
          entry.ownerThreadId === normalizedOwnerThreadId &&
          !entry.changeSetId,
      );
      if (contributions.length === 0) {
        return { contributionCount: 0 };
      }
      // The terminal lifecycle event is already a durable, attempt-scoped id.
      // Prefixing it gives the card/apply identity exact replay stability
      // without another random id that could fork a retried delivery.
      const changeSetId = `self-mod-change-set:${normalizedCompletionEventId}`;
      for (const contribution of contributions) {
        contribution.changeSetId = changeSetId;
        contribution.completionEventId = normalizedCompletionEventId;
      }
      return { changeSetId, contributionCount: contributions.length };
    },

    cancelRun: async (runId) => {
      getStoreModService()?.cancelSelfModRun(runId);

      const controller = getController();
      if (!controller || !controller.hasRun(runId)) {
        finalizedAuthorContributions.delete(runId);
        await releaseRunCompletely(runId, "self-mod-hmr");
        return;
      }

      // Cancel may drain held runs whose only blocker was this one.
      // Apply the drained batch under a morph cover, then release
      // this run's pause separately (cancel is not part of the apply
      // batch — it discards its writes rather than apply them).
      const cancelResult = await controller.cancel(runId);
      finalizedAuthorContributions.delete(runId);
      await releaseRuntimeReloadFor([runId]);
      dropRunBookkeeping([runId]);
      await dispatchApplyBatch(stageAuthorContributions(cancelResult));
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

  const revertWithMorph = async (
    payload: RuntimeSelfModRevertRequest,
  ): Promise<RuntimeSelfModRevertResult> => {
    const repoRoot = getRepoRoot();
    if (!repoRoot) {
      throw new Error("Worker has not been initialized.");
    }
    const requestedApplyId = payload.applyId?.trim();
    const persistedChangeSet = requestedApplyId
      ? getPendingSelfModStore?.()?.getChangeSet(requestedApplyId)
      : null;
    const hasGroupedSelection = payload.commitHashes !== undefined;
    if (
      hasGroupedSelection &&
      (payload.commitHash !== undefined || payload.steps !== undefined)
    ) {
      throw new Error(
        "Grouped self-mod Undo cannot be combined with legacy commit selectors.",
      );
    }
    const clientCommitHashes = hasGroupedSelection
      ? (payload.commitHashes ?? []).map((hash) => hash.trim())
      : [];
    if (hasGroupedSelection) {
      const exactCommitHashes = persistedChangeSet?.commitHashes;
      const clientCommitSet = new Set(clientCommitHashes);
      if (
        !requestedApplyId ||
        !exactCommitHashes ||
        exactCommitHashes.length === 0 ||
        exactCommitHashes.length !== clientCommitHashes.length ||
        clientCommitSet.size !== clientCommitHashes.length ||
        exactCommitHashes.some((hash) => !clientCommitSet.has(hash))
      ) {
        throw new Error(
          "Grouped self-mod Undo does not match the card's durable commit set.",
        );
      }
    }
    const requestedCommitHashes = hasGroupedSelection
      ? (persistedChangeSet?.commitHashes ?? [])
      : [];
    const resolvedCommitHash = hasGroupedSelection
      ? undefined
      : payload.commitHash?.trim() ||
        (await getLastSelfModCommitHash(repoRoot).catch(() => null)) ||
        undefined;

    const executeRevert = async (): Promise<RuntimeSelfModRevertResult> => {
      if (!hasGroupedSelection) {
        return await revertSelfModCommit({
          repoRoot,
          commitHash: resolvedCommitHash,
          steps: payload.steps,
        });
      }
      const grouped = await revertSelfModCommits({
        repoRoot,
        commitHashes: requestedCommitHashes,
      });
      const representativeCommitHash =
        grouped.commitHashes[grouped.commitHashes.length - 1]!;
      return {
        commitHash: representativeCommitHash,
        commitHashes: grouped.commitHashes,
        revertedCommitHashes: grouped.revertedCommitHashes,
        contributions: grouped.contributions,
        files: grouped.files,
        conversationId: grouped.contributions[0]?.conversationId ?? null,
        originThreadKey: grouped.contributions[0]?.originThreadKey ?? null,
        message: grouped.message,
      };
    };

    const recordRevertNotices = (result: RuntimeSelfModRevertResult): void => {
      const contributions = result.contributions;
      if (contributions && contributions.length > 0) {
        for (const contribution of contributions) {
          recordSelfModRevertNotice({
            runtimeStore: getRuntimeStore(),
            conversationId: contribution.conversationId,
            originThreadKey: contribution.originThreadKey,
            commitHash: contribution.commitHash,
            files: contribution.files,
            logScope: "self-mod-revert",
          });
        }
        return;
      }
      recordSelfModRevertNotice({
        runtimeStore: getRuntimeStore(),
        conversationId: result.conversationId,
        originThreadKey: result.originThreadKey,
        commitHash: result.commitHash,
        files: result.files,
        logScope: "self-mod-revert",
      });
    };

    const patchRevertedCard = (result: RuntimeSelfModRevertResult): void => {
      const applyId = requestedApplyId;
      if (!applyId) return;
      if (persistedChangeSet) {
        patchSelfModApplyStatus({
          conversationId: persistedChangeSet.conversationId,
          eventId: persistedChangeSet.assistantMessageEventId,
          applyId,
          status: "reverted",
        });
        return;
      }
      const conversationIds = new Set(
        (result.contributions ?? [])
          .map((entry) => entry.conversationId?.trim())
          .filter((value): value is string => Boolean(value)),
      );
      const legacyConversationId = result.conversationId?.trim();
      if (legacyConversationId) conversationIds.add(legacyConversationId);
      for (const conversationId of conversationIds) {
        patchSelfModApplyStatus({
          conversationId,
          applyId,
          status: "reverted",
        });
      }
    };

    const controller = getController();
    if (!controller) {
      // Worker initialized without HMR wiring (test fixtures, e.g.).
      // Fall back to the raw revert with no morph cover — better than
      // refusing the user's undo entirely.
      const result = await executeRevert();
      recordRevertNotices(result);
      patchRevertedCard(result);
      return result;
    }

    const syntheticRunId = `self-mod-revert:${crypto.randomUUID()}`;
    let runRegisteredWithHmr = false;
    let runtimeReloadPaused = false;

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
        const snapshotHashes = hasGroupedSelection
          ? requestedCommitHashes
          : [resolvedCommitHash ?? null];
        preRevertFiles = [
          ...new Set(
            (
              await Promise.all(
                snapshotHashes.map((commitHash) =>
                  listFilesForCommit(repoRoot, commitHash),
                ),
              )
            ).flat(),
          ),
        ];
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

      const result = await executeRevert();

      // Ledger the revert so the revert-notice hook can inject on
      // the next user turn for every originating contribution. Skipped for
      // commits without a `Stella-Conversation` trailer because there is no
      // safe conversation target.
      recordRevertNotices(result);
      patchRevertedCard(result);

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
        const cancelResult = await controller
          .cancel(syntheticRunId)
          .catch(() => null);
        // Cancel removes the synthetic run's contention ownership. If doing so
        // unblocks an older held run, keep that real work moving through the
        // ordinary transition pipeline instead of stranding it behind the
        // failed Undo.
        if (cancelResult?.appliedRuns.length) {
          await dispatchApplyBatch(cancelResult).catch(() => undefined);
        }
      }
      if (runtimeReloadPaused) {
        await releaseRuntimeReloadFor([syntheticRunId]).catch(() => undefined);
      }
      selfModRunRootIds.delete(syntheticRunId);
      throw err;
    }
  };

  const applyPendingWithMorph = async ({
    applyId,
    commitHash,
  }: {
    applyId?: string;
    commitHash?: string;
  }): Promise<RuntimeSelfModApplyResult> => {
    // `applyId` is the published change-set identity. `commitHash` remains as a
    // compatibility lookup for cards written before grouped change sets were
    // introduced; it is never permission to drain unrelated pending entries.
    const requestedApplyId = applyId?.trim();
    const resolvedCommitHash = commitHash?.trim();
    const repoRoot = getRepoRoot();
    if (!repoRoot) {
      throw new Error("Worker has not been initialized.");
    }
    // `Map` preserves finalize order, which is also the order the merged HMR
    // runs must apply in when one published card contains several contributions.
    const pendingSelfModApplies = getPendingSelfModApplies();
    const allEntries = [...pendingSelfModApplies.values()];
    const compatibilityMatch = resolvedCommitHash
      ? allEntries.find((entry) => entry.commitHash === resolvedCommitHash)
      : undefined;
    const resolvedApplyId =
      requestedApplyId ??
      compatibilityMatch?.changeSetId ??
      compatibilityMatch?.applyId;
    const pendingStore = getPendingSelfModStore?.();
    const durableClaim = pendingStore?.beginApply({
      ...(requestedApplyId ? { applyId: requestedApplyId } : {}),
      ...(resolvedCommitHash ? { commitHash: resolvedCommitHash } : {}),
    });
    const entries = pendingStore
      ? (durableClaim?.contributions ?? [])
      : resolvedApplyId
        ? allEntries.filter((entry) =>
            entry.changeSetId
              ? entry.changeSetId === resolvedApplyId
              : entry.applyId === resolvedApplyId,
          )
        : [];

    if (entries.length === 0) {
      // Never use forceResumeAll here: that would release and surface other
      // cards' unpublished work just because one requested set was missing.
      if (resolvedCommitHash) {
        const [summary] = await listGitCommitsBySelector(
          repoRoot,
          { commitHashes: [resolvedCommitHash] },
          4_000,
        ).catch(() => []);
        if (summary?.conversationId) {
          patchSelfModApplyStatus({
            conversationId: summary.conversationId,
            commitHash: resolvedCommitHash,
            status: "applied",
          });
        }
      }
      return {
        ...(resolvedCommitHash ? { commitHash: resolvedCommitHash } : {}),
        applied: false,
        message: "Pending self-mod apply was not found.",
      };
    }

    const durableChangeSetId = durableClaim?.changeSet.changeSetId;
    const latestCommittedEntry = [...entries]
      .reverse()
      .find((entry) => entry.commitHash);
    const cardApplyId = entries[0]?.changeSetId ?? entries[0]?.applyId;
    const cardConversationId = entries[0]?.conversationId;
    const applied = await dispatchApplyBatch(
      mergePendingApplyResults(entries.map((entry) => entry.applyResult)),
      {
        onApplied: () => {
          if (durableChangeSetId) {
            pendingStore?.completeApply(durableChangeSetId);
          }
          for (const entry of entries) {
            pendingSelfModApplies.delete(entry.applyId);
          }
          if (cardApplyId && cardConversationId) {
            patchSelfModApplyStatus({
              conversationId: cardConversationId,
              eventId: entries[0]?.assistantMessageEventId,
              applyId: cardApplyId,
              // Multi-commit cards intentionally omit the legacy singular
              // hash. The grouped payload carries `commitHashes`; exposing one
              // hash here would let an old UI partially undo the update.
              ...(entries.length === 1 && latestCommittedEntry?.commitHash
                ? { commitHash: latestCommittedEntry.commitHash }
                : {}),
              status: "applied",
            });
          }
        },
        onFailed: () => {
          if (durableChangeSetId) {
            pendingStore?.failApply(durableChangeSetId);
          }
        },
      },
    );
    if (!applied) {
      return {
        ...(resolvedCommitHash ? { commitHash: resolvedCommitHash } : {}),
        applied: false,
        message: "Self-mod HMR apply failed.",
      };
    }
    // Report the clicked change's commit when the caller named one, else the
    // newest committed change in the batch we just applied.
    const reportedCommitHash =
      resolvedCommitHash ?? latestCommittedEntry?.commitHash;
    return {
      ...(reportedCommitHash ? { commitHash: reportedCommitHash } : {}),
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
    const settlePending = (outcome: "applied" | "failed"): boolean => {
      try {
        if (outcome === "applied") pending.settleApplied();
        else pending.settleFailed();
        return true;
      } catch (error) {
        console.warn(
          `[self-mod-hmr] Failed to persist ${outcome} transition state:`,
          (error as Error).message,
        );
        if (outcome === "applied") {
          try {
            pending.settleFailed();
          } catch {
            // Startup recovery resets a surviving `applying` claim.
          }
        }
        return false;
      }
    };
    if (pending.requiresProcessRestart) {
      const discarded = controller
        ? await controller.discard(pending.applyResult.appliedRuns)
        : false;
      if (!discarded) {
        console.warn(
          "[self-mod-hmr] Failed to discard Vite state before process restart.",
        );
      }
      const settled = settlePending("applied");
      pendingApplyBatches.delete(transitionId);
      await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
        allowDeferredReload: false,
      });
      dropRunBookkeeping(pending.applyResult.restartRelevantRunIds);
      return settled
        ? { ok: true, requiresClientFullReload: false }
        : { ok: false, reason: "apply-failed" };
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
      settlePending("failed");
      pendingApplyBatches.delete(transitionId);
      await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
        allowDeferredReload: pending.requiresRuntimeRestart,
      });
      dropRunBookkeeping(pending.applyResult.restartRelevantRunIds);
      return { ok: false, reason: "apply-failed" };
    }
    const settled = settlePending("applied");
    pendingApplyBatches.delete(transitionId);
    await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
      allowDeferredReload: pending.requiresRuntimeRestart,
    });
    dropRunBookkeeping(pending.applyResult.restartRelevantRunIds);
    return settled
      ? {
          ok: true,
          requiresClientFullReload:
            applyResponse.requiresClientFullReload === true,
        }
      : { ok: false, reason: "apply-failed" };
  };

  return {
    lifecycle,
    externalLifecycle,
    revertWithMorph,
    applyPendingWithMorph,
    resumeTransition,
    releasePendingApplyBatches,
    hasPendingApplyBatches: () => pendingApplyBatches.size > 0,
  };
};
