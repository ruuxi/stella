import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import type {
  AgentStreamIpcEvent,
  DesktopReleaseSourceHistoryRef,
  ElectronUpdatesApi,
  InstallManifestSnapshot,
  StellaReleaseArtifactRef,
} from "@/shared/types/electron";

const DEFAULT_REPO_OWNER = "ruuxi";
const DEFAULT_REPO_NAME = "stella";
const UPDATE_METADATA_TIMEOUT_MS = 20_000;

export type ActiveDesktopUpdate = {
  status: "starting" | "running" | "background";
  conversationId: string;
  requestId?: string;
  runId?: string;
  targetCommit: string;
  targetTag: string;
};

let activeDesktopUpdate: ActiveDesktopUpdate | null = null;
const activeDesktopUpdateListeners = new Set<() => void>();

const emitActiveDesktopUpdateChange = () => {
  for (const listener of activeDesktopUpdateListeners) {
    listener();
  }
};

const setActiveDesktopUpdate = (next: ActiveDesktopUpdate | null) => {
  activeDesktopUpdate = next;
  emitActiveDesktopUpdateChange();
};

export const getActiveDesktopUpdate = (): ActiveDesktopUpdate | null =>
  activeDesktopUpdate;

export const subscribeActiveDesktopUpdate = (listener: () => void) => {
  activeDesktopUpdateListeners.add(listener);
  return () => {
    activeDesktopUpdateListeners.delete(listener);
  };
};

export const cancelActiveDesktopUpdate = (): boolean => {
  const runId = activeDesktopUpdate?.runId;
  if (!runId) return false;
  window.electronAPI?.agent?.cancelChat?.(runId);
  return true;
};

type ApplyDesktopUpdateOptions = {
  installManifest: InstallManifestSnapshot;
  publishedCommit: string;
  publishedTag: string;
  publishedAt: number;
  sourcePackRef?: {
    kind: "url";
    url: string;
    sha256: string;
    sizeBytes: number;
  };
  sourceHistoryRef?: DesktopReleaseSourceHistoryRef;
  artifactRefs?: StellaReleaseArtifactRef[];
  onAppliedCommit?: (
    manifest: InstallManifestSnapshot | null,
  ) => void | Promise<void>;
  onFinished?: (event: AgentStreamIpcEvent) => void;
};

type ApplyDesktopUpdateResult = {
  requestId: string;
  conversationId: string;
  mode: "auto" | "agent";
  cancel: () => boolean;
};

export type UpdateAgentFallback = {
  reason: string;
  headCommit?: string;
  changedFiles?: string[];
  sourcePackFile?: string;
  sourcePackConflictFile?: string;
  sourcePackConflictJson?: string;
};

type DesktopUpdateRollbackSnapshot = {
  startingHeadCommit: string;
  releaseTag: string;
  changedFiles: string[];
};

const withUpdateMetadataTimeout = async <T>(
  label: string,
  promise: Promise<T>,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Desktop update metadata step "${label}" timed out after ${Math.round(UPDATE_METADATA_TIMEOUT_MS / 1000)}s.`,
          ),
        );
      }, UPDATE_METADATA_TIMEOUT_MS);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const recordOfficialDesktopUpdateSourceHistory = async (args: {
  updatesApi:
    | Pick<ElectronUpdatesApi, "recordSourceHistory">
    | null
    | undefined;
  targetCommit: string;
  releaseTag: string;
  sourceHistoryRef?: DesktopReleaseSourceHistoryRef;
}): Promise<void> => {
  const recordSourceHistory = args.updatesApi?.recordSourceHistory;
  if (!recordSourceHistory) return;
  try {
    await withUpdateMetadataTimeout(
      "record source history",
      recordSourceHistory({
        targetCommit: args.targetCommit,
        releaseTag: args.releaseTag,
        ...(args.sourceHistoryRef
          ? { sourceHistoryRef: args.sourceHistoryRef }
          : {}),
      }),
    );
  } catch (error) {
    console.warn(
      "[updates] Failed to record official desktop source history:",
      error,
    );
  }
};

export const buildInstallUpdatePrompt = (args: {
  repoOwner: string;
  repoName: string;
  baseCommit: string;
  targetCommit: string;
  releaseTag: string;
  installRoot: string;
  fallback: UpdateAgentFallback | null;
}) => {
  const conflictLines = args.fallback?.sourcePackConflictFile
    ? [
        "Fast update path: Stella source-pack merge needs agent resolution.",
        `Fast path reason: ${args.fallback.reason}`,
        ...(args.fallback.sourcePackFile
          ? [
              `Full source pack: ${args.fallback.sourcePackFile} (relative to the install root)`,
            ]
          : []),
        `Conflict file: ${args.fallback.sourcePackConflictFile} (relative to the install root, kept for audit)`,
        ...(args.fallback.headCommit
          ? [
              `Starting HEAD before agent resolution: ${args.fallback.headCommit}`,
            ]
          : []),
        "The conflict file lists compatible appliedPaths and appliedChanges. Apply each appliedChanges entry exactly as its content field specifies, then resolve the conflicts, stage, and commit the complete result.",
        ...(args.fallback.changedFiles?.length
          ? [
              "Source-pack touched paths:",
              ...args.fallback.changedFiles.map((file) => `- ${file}`),
            ]
          : []),
        "",
        ...(args.fallback.sourcePackConflictJson
          ? [
              "Source-pack conflict JSON:",
              "```json",
              args.fallback.sourcePackConflictJson.trimEnd(),
              "```",
              "",
              "Use the embedded conflict JSON first. It contains base, local, and next content for conflicted paths, plus appliedChanges with exact final content for compatible paths. Apply the compatible text changes from appliedChanges, resolve the conflicted files directly in the install root, preserve local edits, stage and commit the result, and install dependencies only if package manifests or lockfiles changed. If appliedChanges contains binary content that cannot be written with your tools, use the Git fallback instead.",
            ]
          : [
              "The conflict JSON was too large to embed in this prompt. Use the Git fallback instead of trying to read state files from disk.",
              "Fetch the target commit, merge it, resolve conflicts only if Git reports them, and install dependencies only if package manifests or lockfiles changed.",
            ]),
      ]
    : [
        ...(args.fallback
          ? [
              `Fast update path could not apply automatically: ${args.fallback.reason}`,
              "",
            ]
          : []),
        "Run the normal update merge from the install root: fetch the target commit, merge it, resolve conflicts only if Git reports them, and install dependencies only if package manifests or lockfiles changed.",
      ];
  return [
    "You are the install-update agent. Apply the upstream change set below.",
    "",
    `Repository: ${args.repoOwner}/${args.repoName}`,
    `Base commit (currently installed): ${args.baseCommit}`,
    `Target commit (latest published): ${args.targetCommit}`,
    `Release tag: ${args.releaseTag}`,
    `Install root: ${args.installRoot}`,
    "",
    ...conflictLines,
    "When finished, report which files updated cleanly, which were merged with local edits, and which were skipped.",
  ].join("\n");
};

const buildSyntheticCompletedEvent = (
  conversationId: string,
  runId: string,
): AgentStreamIpcEvent =>
  ({
    type: "run-finished",
    runId,
    seq: 0,
    conversationId,
    agentType: AGENT_IDS.INSTALL_UPDATE,
    outcome: "completed",
  }) as AgentStreamIpcEvent;

/**
 * Apply a desktop update.
 *
 * Clean merges go through a native Electron fast path that brackets the
 * merge in the same self-mod HMR/morph lifecycle as agent-authored writes.
 * Conflict or dirty-tree cases fall back to the install-update agent.
 */
export const applyDesktopUpdate = async (
  options: ApplyDesktopUpdateOptions,
): Promise<ApplyDesktopUpdateResult | null> => {
  const electronApi = window.electronAPI;
  if (!electronApi?.agent?.startChat) {
    throw new Error("Stella runtime is not available.");
  }
  if (
    !electronApi.agent.onStream ||
    !electronApi.updates?.tryApplyCleanUpdate ||
    !electronApi.updates?.refreshNativeHelpers ||
    !electronApi.updates?.recordAppliedCommit
  ) {
    throw new Error("Stella update tracking is not available.");
  }
  if (activeDesktopUpdate) {
    throw new Error("A Stella update is already running.");
  }

  const baseCommit =
    options.installManifest.installState?.desktopReleaseCommit ??
    options.installManifest.desktopReleaseCommit ??
    options.installManifest.desktopInstallBaseCommit;
  if (!baseCommit) {
    throw new Error(
      "This install is missing a base commit reference. Reinstall is required before updates can be tracked.",
    );
  }

  const conversationId = `install-update-${crypto.randomUUID()}`;
  const repoOwner = DEFAULT_REPO_OWNER;
  const repoName = DEFAULT_REPO_NAME;
  setActiveDesktopUpdate({
    status: "starting",
    conversationId,
    targetCommit: options.publishedCommit,
    targetTag: options.publishedTag,
  });

  const platform = electronApi.platform ?? "darwin";
  const timezone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";
  const deviceId = (await getDeviceIdOrNull()) ?? "";

  setActiveDesktopUpdate({
    status: "running",
    conversationId,
    targetCommit: options.publishedCommit,
    targetTag: options.publishedTag,
  });
  let fastApplyFallback: UpdateAgentFallback | null = null;
  try {
    const fastApply = await electronApi.updates.tryApplyCleanUpdate({
      baseCommit,
      targetCommit: options.publishedCommit,
      releaseTag: options.publishedTag,
      ...(options.sourcePackRef
        ? { sourcePackRef: options.sourcePackRef }
        : {}),
      ...(options.artifactRefs ? { artifactRefs: options.artifactRefs } : {}),
    });
    if (fastApply.status === "applied") {
      await options.onAppliedCommit?.(fastApply.manifest);
      if (getActiveDesktopUpdate()?.conversationId === conversationId) {
        setActiveDesktopUpdate(null);
      }
      options.onFinished?.(
        buildSyntheticCompletedEvent(
          conversationId,
          `desktop-update-fast:${options.publishedCommit.slice(0, 12)}`,
        ),
      );
      void recordOfficialDesktopUpdateSourceHistory({
        updatesApi: electronApi.updates,
        targetCommit: options.publishedCommit,
        releaseTag: options.publishedTag,
        ...(options.sourceHistoryRef
          ? { sourceHistoryRef: options.sourceHistoryRef }
          : {}),
      });
      return {
        requestId: `desktop-update-fast:${conversationId}`,
        conversationId,
        mode: "auto",
        cancel: () => false,
      };
    }
    fastApplyFallback = {
      reason: fastApply.reason,
      ...(fastApply.headCommit ? { headCommit: fastApply.headCommit } : {}),
      ...(fastApply.changedFiles
        ? { changedFiles: fastApply.changedFiles }
        : {}),
      ...(fastApply.sourcePackFile
        ? { sourcePackFile: fastApply.sourcePackFile }
        : {}),
      ...(fastApply.sourcePackConflictFile
        ? { sourcePackConflictFile: fastApply.sourcePackConflictFile }
        : {}),
      ...(fastApply.sourcePackConflictJson
        ? { sourcePackConflictJson: fastApply.sourcePackConflictJson }
        : {}),
    };
  } catch (error) {
    if (getActiveDesktopUpdate()?.conversationId === conversationId) {
      setActiveDesktopUpdate(null);
    }
    throw error;
  }

  const prompt = buildInstallUpdatePrompt({
    repoOwner,
    repoName,
    baseCommit,
    targetCommit: options.publishedCommit,
    releaseTag: options.publishedTag,
    installRoot: options.installManifest.installPath,
    fallback: fastApplyFallback,
  });
  const sourcePackStartingHeadCommit =
    fastApplyFallback?.sourcePackConflictFile && fastApplyFallback.headCommit
      ? fastApplyFallback.headCommit
      : null;
  const rollbackSnapshot: DesktopUpdateRollbackSnapshot | null =
    fastApplyFallback?.headCommit
      ? {
          startingHeadCommit: fastApplyFallback.headCommit,
          releaseTag: options.publishedTag,
          changedFiles: fastApplyFallback.changedFiles ?? [],
        }
      : null;

  setActiveDesktopUpdate({
    status: "background",
    conversationId,
    targetCommit: options.publishedCommit,
    targetTag: options.publishedTag,
  });

  // Subscribe BEFORE startChat so we don't miss a fast-completing run.
  // On a successful RUN_FINISHED for this install-update conversation,
  // persist the applied commit into the launcher manifest. The
  // subscription auto-cleans on terminal outcome.
  let unsubscribe: (() => void) | null = null;
  unsubscribe = electronApi.agent.onStream((event) => {
    if (
      event.type === "run-started" &&
      event.conversationId === conversationId &&
      event.agentType === AGENT_IDS.INSTALL_UPDATE
    ) {
      if (activeDesktopUpdate?.conversationId === conversationId) {
        setActiveDesktopUpdate({
          ...activeDesktopUpdate,
          status: "background",
          runId: event.runId,
        });
      }
      return;
    }
    if (
      event.type !== "run-finished" ||
      event.conversationId !== conversationId ||
      event.agentType !== AGENT_IDS.INSTALL_UPDATE
    ) {
      return;
    }
    void (async () => {
      // The agent's "completed" outcome only means the agent thread finished
      // without crashing — it does NOT prove the update actually landed.
      // `recordAppliedCommit` verifies Git ancestry for normal merges, or a
      // clean new local commit for source-pack conflict resolution.
      let effectiveEvent: AgentStreamIpcEvent = event;
      try {
        if (event.outcome === "completed") {
          await electronApi.updates.refreshNativeHelpers(
            options.publishedTag,
            options.artifactRefs,
          );
          const manifest = await electronApi.updates.recordAppliedCommit(
            options.publishedCommit,
            options.publishedTag,
            sourcePackStartingHeadCommit
              ? {
                  mode: "release-pointer",
                  startingHeadCommit: sourcePackStartingHeadCommit,
                }
              : undefined,
          );
          await recordOfficialDesktopUpdateSourceHistory({
            updatesApi: electronApi.updates,
            targetCommit: options.publishedCommit,
            releaseTag: options.publishedTag,
            ...(options.sourceHistoryRef
              ? { sourceHistoryRef: options.sourceHistoryRef }
              : {}),
          });
          await options.onAppliedCommit?.(manifest);
        }
      } catch (err) {
        const reason =
          (err as Error)?.message ??
          "Stella couldn't verify the update landed in the install tree.";
        console.warn("[install-update] Verification failed:", err);
        effectiveEvent = {
          ...event,
          outcome: "error",
          reason,
          error: reason,
        };
      } finally {
        if (effectiveEvent.outcome === "canceled" && rollbackSnapshot) {
          await electronApi.updates
            .rollbackCanceledUpdate(rollbackSnapshot)
            .catch((error) => {
              console.warn(
                "[install-update] Canceled update rollback failed:",
                error,
              );
            });
        }
        options.onFinished?.(effectiveEvent);
        if (activeDesktopUpdate?.conversationId === conversationId) {
          setActiveDesktopUpdate(null);
        }
        unsubscribe?.();
        unsubscribe = null;
      }
    })();
  });

  try {
    const result = await electronApi.agent.startChat({
      conversationId,
      userPrompt: prompt,
      deviceId,
      platform,
      timezone,
      agentType: AGENT_IDS.INSTALL_UPDATE,
      storageMode: "local",
      selfModMetadata: {
        mode: "desktop-update",
      },
      messageMetadata: {
        installUpdate: {
          baseCommit,
          targetCommit: options.publishedCommit,
          targetTag: options.publishedTag,
          publishedAt: options.publishedAt,
          installRoot: options.installManifest.installPath,
          repoOwner,
          repoName,
          ...(fastApplyFallback
            ? { fastApplyReason: fastApplyFallback.reason }
            : {}),
          ...(fastApplyFallback?.sourcePackConflictFile
            ? {
                sourcePackConflictFile:
                  fastApplyFallback.sourcePackConflictFile,
              }
            : {}),
        },
      },
    });
    const currentActiveUpdate = getActiveDesktopUpdate();
    if (currentActiveUpdate?.conversationId === conversationId) {
      setActiveDesktopUpdate({
        ...currentActiveUpdate,
        requestId: result.requestId,
      });
    }
    return {
      requestId: result.requestId,
      conversationId,
      mode: "agent",
      cancel: cancelActiveDesktopUpdate,
    };
  } catch (err) {
    if (getActiveDesktopUpdate()?.conversationId === conversationId) {
      setActiveDesktopUpdate(null);
    }
    unsubscribe?.();
    throw err;
  }
};
