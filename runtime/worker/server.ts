import crypto from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonRpcPeer } from "../protocol/rpc-peer.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type AgentHealth,
  type HostDeviceIdentity,
  type RuntimeAttachmentRef,
  type RuntimeAgentEventPayload,
  type RuntimeChatPayload,
  type StorePublishArgs,
  type RuntimeLocalAgentRequest,
} from "../protocol/index.js";
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
  type AgentRunFinishOutcome,
  type AgentStreamEventType,
} from "../../desktop/src/shared/contracts/agent-runtime.js";
import { prepareStoredLocalChatPayload } from "../kernel/storage/local-chat-payload.js";
import { collectAllSignals } from "../discovery/collect-all.js";
import {
  collectBrowserData,
  formatBrowserDataForSynthesis,
} from "../discovery/browser-data.js";
import {
  createStellaHostRunner,
  type StellaHostRunnerOptions,
} from "../kernel/runner.js";
import { buildChatPromptMessages } from "../kernel/chat-prompt-context.js";
import { getDevServerUrl } from "./dev-url.js";
import {
  detectSelfModAppliedSince,
  getLastGitFeatureId,
  getGitHead,
  listRecentGitFeatures,
  parseStellaCommitTrailers,
} from "../kernel/self-mod/git.js";
import {
  createSelfModHmrController,
  type ApplyOptions,
  type ApplyResult,
  type HmrApplyResponse,
  type SelfModHmrController,
} from "../kernel/self-mod/hmr.js";
import { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import { buildFeatureRoster } from "../kernel/self-mod/feature-roster.js";
import { revertGitCommits, revertGitFeature } from "../kernel/self-mod/git.js";
import { createDesktopDatabase } from "../kernel/storage/database.js";
import { ChatStore } from "../kernel/storage/chat-store.js";
import { RuntimeStore } from "../kernel/storage/runtime-store.js";
import { StoreModStore } from "../kernel/storage/store-mod-store.js";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import {
  createEmptySocialSessionServiceSnapshot,
  type StorePackageRecord,
  type StorePackageReleaseRecord,
  type StoreReleaseArtifact,
} from "../contracts/index.js";
import { SocialSessionService } from "./social-sessions/service.js";
import { SocialSessionStore } from "./social-sessions/store.js";
import { VoiceRuntimeService } from "./voice/service.js";
import { createRuntimeLogger } from "../kernel/debug.js";

type WorkerInitializationState = {
  stellaRoot: string;
  stellaWorkspacePath: string;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  hasConnectedAccount: boolean;
  cloudSyncEnabled: boolean;
};

const logger = createRuntimeLogger("worker.server");

type RuntimeRunner = ReturnType<typeof createStellaHostRunner>;

const resolveDesktopCliEntrypoint = (
  stellaRoot: string,
  packageName: string,
  entrypoint: string,
): string => {
  const desktopLocal = path.join(
    stellaRoot,
    "desktop",
    packageName,
    "bin",
    entrypoint,
  );
  if (existsSync(desktopLocal)) {
    return desktopLocal;
  }

  return path.join(stellaRoot, packageName, "bin", entrypoint);
};

type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  chunk?: string;
  statusState?: "running" | "compacting";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  details?: unknown;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
  agentId?: string;
  agentType?: AgentIdLike;
  rootRunId?: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

type WorkerState = {
  init: WorkerInitializationState | null;
  db: SqliteDatabase | null;
  chatStore: ChatStore | null;
  runtimeStore: RuntimeStore | null;
  storeModStore: StoreModStore | null;
  storeModService: StoreModService | null;
  socialSessionStore: SocialSessionStore | null;
  socialSessionService: SocialSessionService | null;
  voiceService: VoiceRuntimeService | null;
  runner: RuntimeRunner | null;
  deviceId: string | null;
  selfModHmrController: SelfModHmrController | null;
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
};

const logSelfModHmrWorker = (
  phase: string,
  data: Record<string, unknown> = {},
): void => {
  process.stderr.write(
    `[self-mod-hmr:worker] ${phase} ${JSON.stringify(data)}\n`,
  );
};

// Resolve a runtime CLI bundled into desktop/dist-electron/runtime/kernel/cli/.
// `import.meta.url` for this file at runtime is
// `desktop/dist-electron/runtime/worker/server.js`, so we walk up to
// `runtime/` and then back down into `kernel/cli/`. The previous
// `../../kernel/cli/...` form skipped the `runtime/` segment and resolved
// to a path that does not exist on disk, surfacing as
// `Module not found "<...>/dist-electron/kernel/cli/stella-computer.js"`
// in agent runs.
const resolveRuntimeCliPath = (fileName: string) =>
  fileURLToPath(new URL(`../kernel/cli/${fileName}`, import.meta.url));

const writeBlueprintArtifact = async (args: {
  stellaRoot: string;
  packageId: string;
  releaseNumber: number;
  artifact: StoreReleaseArtifact;
}): Promise<string> => {
  const releaseDir = path.join(
    args.stellaRoot,
    "state",
    "mods",
    "store-blueprints",
    args.packageId,
  );
  await fs.mkdir(releaseDir, { recursive: true });
  const filePath = path.join(releaseDir, `release-${args.releaseNumber}.json`);
  await fs.writeFile(filePath, JSON.stringify(args.artifact, null, 2), "utf-8");
  return filePath;
};

const buildStoreInstallPrompt = (args: {
  blueprintPath: string;
  packageRecord: StorePackageRecord;
  release: StorePackageReleaseRecord;
  mode: "install" | "update";
}): string =>
  [
    `${args.mode === "update" ? "Update" : "Install"} the Stella store package "${args.packageRecord.displayName}" (${args.packageRecord.packageId}).`,
    `Use the blueprint JSON at "${args.blueprintPath.replace(/\\/g, "/")}" as the reference implementation.`,
    "Read that blueprint before making changes.",
    "The blueprint contains exact commit patches and reference file content from the published release.",
    "Apply the intended changes to the current local Stella codebase.",
    "Stella installations may differ, so adapt the implementation instead of blindly copying text.",
    "Create missing files when the blueprint expects them, update existing files to preserve the intended behavior, and delete files only when the blueprint clearly marks them as removed.",
    `Target packageId: ${args.packageRecord.packageId}. Target releaseNumber: ${args.release.releaseNumber}.`,
  ].join("\n\n");

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;
const HTTP_URL_RE = /^https?:\/\//i;

type MaterializedImageAttachment = {
  index: number;
  attachment: RuntimeAttachmentRef;
};

const normalizeAttachmentMimeType = (
  value: string | null | undefined,
): string => value?.split(";")[0]?.trim().toLowerCase() ?? "";

const isImageMimeType = (mimeType: string): boolean =>
  mimeType.startsWith("image/");

const encodeImageDataUrl = (mimeType: string, data: ArrayBuffer): string =>
  `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;

const materializeImageAttachments = async (
  attachments: RuntimeAttachmentRef[] | undefined,
): Promise<MaterializedImageAttachment[]> => {
  const materialized: MaterializedImageAttachment[] = [];

  for (const [index, attachment] of (attachments ?? []).entries()) {
    const url = asTrimmedString(attachment.url);
    if (!url) {
      continue;
    }

    const hintedMimeType = normalizeAttachmentMimeType(attachment.mimeType);
    const dataUrlMatch = DATA_URL_RE.exec(url);
    if (dataUrlMatch) {
      const mimeType =
        hintedMimeType || normalizeAttachmentMimeType(dataUrlMatch[1]);
      if (!isImageMimeType(mimeType)) {
        continue;
      }
      materialized.push({
        index,
        attachment: {
          url,
          mimeType,
        },
      });
      continue;
    }

    if (!HTTP_URL_RE.test(url)) {
      continue;
    }
    if (hintedMimeType && !isImageMimeType(hintedMimeType)) {
      continue;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn("startChat.attachment-materialize-failed", {
          url,
          status: response.status,
          statusText: response.statusText,
        });
        continue;
      }

      const responseMimeType = normalizeAttachmentMimeType(
        response.headers.get("content-type"),
      );
      const mimeType = responseMimeType || hintedMimeType;
      if (!isImageMimeType(mimeType)) {
        continue;
      }

      materialized.push({
        index,
        attachment: {
          url: encodeImageDataUrl(mimeType, await response.arrayBuffer()),
          mimeType,
        },
      });
    } catch (error) {
      logger.warn("startChat.attachment-materialize-failed", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return materialized;
};

const replaceStoredImageAttachments = (
  attachments: RuntimeAttachmentRef[] | undefined,
  materializedImages: MaterializedImageAttachment[],
): RuntimeAttachmentRef[] | undefined => {
  if (!attachments?.length) {
    return undefined;
  }

  const replacementByIndex = new Map(
    materializedImages.map(({ index, attachment }) => [index, attachment]),
  );

  return attachments.map(
    (attachment, index) => replacementByIndex.get(index) ?? attachment,
  );
};

const stopWorkerServices = async (state: WorkerState) => {
  state.socialSessionService?.stop();
  state.socialSessionService = null;
  state.voiceService = null;
  state.runner?.stop();
  state.runner = null;
  state.chatStore = null;
  state.runtimeStore = null;
  state.storeModStore = null;
  state.storeModService = null;
  state.socialSessionStore = null;
  state.selfModHmrController = null;
  state.db?.close();
  state.db = null;
};

export const createRuntimeWorkerServer = (peer: JsonRpcPeer) => {
  let shuttingDown = false;
  const state: WorkerState = {
    init: null,
    db: null,
    chatStore: null,
    runtimeStore: null,
    storeModStore: null,
    storeModService: null,
    socialSessionStore: null,
    socialSessionService: null,
    voiceService: null,
    runner: null,
    deviceId: null,
    selfModHmrController: null,
  };
  const pendingApplyBatches = new Map<string, PendingApplyBatch>();
  const selfModRunRootIds = new Map<string, string>();

  // Hoisted out of initializeWorker so both the lifecycle hooks (declared
  // during init) and the INTERNAL_WORKER_RESUME_HMR handler (registered at
  // module load) can share it. The helper is stateless beyond the captured
  // `peer`.
  const releaseRuntimeReloadFor = async (
    runIds: string[],
    options?: { allowDeferredReload?: boolean },
  ) => {
    await Promise.all(
      runIds.map(async (runId) => {
        try {
          await peer.request(METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME, {
            runId,
            allowDeferredReload: options?.allowDeferredReload !== false,
          });
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
    const controller = state.selfModHmrController;
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

  const emitRunEvent = (event: AgentEventPayload) => {
    peer.notify(NOTIFICATION_NAMES.RUN_EVENT, event);
  };

  const emitSelfModHmrState = (payload: { runId?: string; state: unknown }) => {
    peer.notify(NOTIFICATION_NAMES.RUN_SELF_MOD_HMR_STATE, payload);
  };

  const emitVoiceAgentEvent = (payload: {
    requestId: string;
    event: RuntimeAgentEventPayload;
  }) => {
    peer.notify(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, payload);
  };

  const emitVoiceSelfModHmrState = (payload: {
    requestId: string;
    runId?: string;
    state: unknown;
  }) => {
    peer.notify(NOTIFICATION_NAMES.VOICE_SELF_MOD_HMR_STATE, payload);
  };

  const persistAssistantMessage = (args: {
    conversationId: string;
    text: string;
    userMessageId: string;
    timezone?: string;
    responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  }) => {
    const trimmedText = args.text.trim();
    if (!trimmedText) {
      return;
    }

    const runtimeMetadata = args.responseTarget
      ? {
          runtime: {
            responseTarget: args.responseTarget,
          },
        }
      : undefined;

    ensureChatStore().appendEvent({
      conversationId: args.conversationId,
      type: "assistant_message",
      requestId: args.userMessageId,
      payload: prepareStoredLocalChatPayload({
        type: "assistant_message",
        payload: {
          text: trimmedText,
          userMessageId: args.userMessageId,
          ...(runtimeMetadata ? { metadata: runtimeMetadata } : {}),
        },
        timestamp: Date.now(),
        timezone: args.timezone,
      }),
    });
    peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
  };

  const ensureRunner = () => {
    if (!state.runner) {
      throw new Error("Runtime worker is not ready.");
    }
    return state.runner;
  };

  const ensureChatStore = () => {
    if (!state.chatStore) {
      throw new Error("Chat store is not available.");
    }
    return state.chatStore;
  };

  const ensureStoreModService = () => {
    if (!state.storeModService) {
      throw new Error("Store mod service is not available.");
    }
    return state.storeModService;
  };

  const ensureVoiceService = () => {
    if (!state.voiceService) {
      throw new Error("Voice runtime service is not available.");
    }
    return state.voiceService;
  };

  const initializeWorker = async (init: WorkerInitializationState) => {
    await stopWorkerServices(state);
    await releasePendingApplyBatches("worker initialization");
    state.init = init;

    const db = createDesktopDatabase(init.stellaRoot);
    const chatStore = new ChatStore(db);
    const runtimeStore = chatStore as RuntimeStore;
    const storeModStore = new StoreModStore(db);
    const socialSessionStore = new SocialSessionStore(db);
    const storeModService = new StoreModService(init.stellaRoot, storeModStore);
    const deviceIdentity = await peer.request<HostDeviceIdentity>(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
    );
    state.deviceId = deviceIdentity.deviceId;
    const selfModHmrController = createSelfModHmrController({
      getDevServerUrl,
      enabled: process.env.NODE_ENV === "development",
      repoRoot: init.stellaRoot,
      authToken: process.env.STELLA_SELF_MOD_HMR_TOKEN,
    });
    state.selfModHmrController = selfModHmrController;
    await selfModHmrController.forceResumeAll().catch((error) => {
      console.warn(
        "[self-mod-hmr] Failed to clear stale Vite state during worker initialization:",
        (error as Error).message,
      );
      return false;
    });

    state.db = db;
    state.chatStore = chatStore;
    state.runtimeStore = runtimeStore;
    state.storeModStore = storeModStore;
    state.storeModService = storeModService;
    state.socialSessionStore = socialSessionStore;

    // ---- self-mod apply orchestration ----
    // The worker server owns morph orchestration: each finalize/cancel that
    // produces an apply batch flows through `dispatchApplyBatch`, which
    // raises the morph cover on the host (HOST_HMR_RUN_TRANSITION) and
    // waits for the host's INTERNAL_WORKER_RESUME_HMR callback before
    // running the actual `selfModHmrController.apply` and releasing the
    // per-runId runtime-reload pauses.
    const dispatchApplyBatch = async (applyResult: ApplyResult) => {
      if (applyResult.appliedRuns.length === 0) {
        logSelfModHmrWorker("dispatchApplyBatch:skipped", {
          reason: "no-applied-runs",
          restartRelevantRunIds: applyResult.restartRelevantRunIds,
          hasRestartRelevantPaths: applyResult.hasRestartRelevantPaths,
          hasFullReloadRelevantPaths: applyResult.hasFullReloadRelevantPaths,
        });
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
      const requiresFullReload =
        applyResult.hasRestartRelevantPaths ||
        applyResult.hasFullReloadRelevantPaths;
      pendingApplyBatches.set(transitionId, {
        applyResult,
        requiresFullReload,
      });
      logSelfModHmrWorker("dispatchApplyBatch", {
        transitionId,
        runIds: applyResult.restartRelevantRunIds,
        stateRunIds,
        requiresFullReload,
        appliedRuns: applyResult.appliedRuns.map((run) => ({
          runId: run.runId,
          paths: run.paths,
          restartRelevantPaths: run.restartRelevantPaths,
          fullReloadRelevantPaths: run.fullReloadRelevantPaths,
        })),
        hasRestartRelevantPaths: applyResult.hasRestartRelevantPaths,
        hasFullReloadRelevantPaths: applyResult.hasFullReloadRelevantPaths,
      });
      try {
        await peer.request(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, {
          transitionId,
          runIds: applyResult.restartRelevantRunIds,
          stateRunIds,
          requiresFullReload,
        });
      } catch (error) {
        console.warn(
          "[self-mod-hmr] HOST_HMR_RUN_TRANSITION failed; applying without morph cover:",
          (error as Error).message,
        );
        // Host couldn't drive the cover (no Electron, or shutting down). Try
        // the apply directly, but only release runtime-reload pauses after
        // Vite confirms it accepted the overlay update.
        if (pendingApplyBatches.has(transitionId)) {
          const applyResponse = await selfModHmrController
            .apply(applyResult.appliedRuns, {
              forceClientFullReload: requiresFullReload,
            })
            .catch((): HmrApplyResponse => ({ ok: false }));
          if (!applyResponse.ok) {
            logSelfModHmrWorker("directApply:failed", {
              transitionId,
              requiresFullReload,
            });
            console.warn(
              "[self-mod-hmr] Direct apply failed; discarding Vite self-mod state before releasing runtime reload pause.",
            );
            await discardFailedApplyState(applyResult, "direct apply failure");
            pendingApplyBatches.delete(transitionId);
            await releaseRuntimeReloadFor(applyResult.restartRelevantRunIds, {
              allowDeferredReload: requiresFullReload,
            });
            for (const runId of applyResult.restartRelevantRunIds) {
              selfModRunRootIds.delete(runId);
            }
            return;
          }
          logSelfModHmrWorker("directApply:done", {
            transitionId,
            requiresFullReload,
            requiresClientFullReload:
              applyResponse.requiresClientFullReload === true,
          });
          pendingApplyBatches.delete(transitionId);
          await releaseRuntimeReloadFor(applyResult.restartRelevantRunIds, {
            allowDeferredReload: requiresFullReload,
          });
          for (const runId of applyResult.restartRelevantRunIds) {
            selfModRunRootIds.delete(runId);
          }
        }
      }
    };

    const runnerOptions: StellaHostRunnerOptions = {
      deviceId: deviceIdentity.deviceId,
      stellaRoot: init.stellaRoot,
      runtimeStore,
      listLocalChatEvents: (conversationId, maxItems) =>
        chatStore.listEvents(conversationId, maxItems),
      appendLocalChatEvent: (args) => {
        chatStore.appendEvent(args);
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      },
      getDefaultConversationId: () =>
        chatStore.getOrCreateDefaultConversationId(),
      requestCredential: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, payload),
      requestRuntimeAuthRefresh: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH, payload),
      displayHtml: async (html) => {
        await peer.request(METHOD_NAMES.HOST_DISPLAY_UPDATE, { html });
      },
      scheduleApi: {
        listCronJobs: async () =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS),
        addCronJob: async (input) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB,
            input,
          ),
        updateCronJob: async (jobId, patch) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB, {
            jobId,
            patch,
          }),
        removeCronJob: async (jobId) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB, {
            jobId,
          }),
        runCronJob: async (jobId) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB, {
            jobId,
          }),
        getHeartbeatConfig: async (conversationId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG,
            {
              conversationId,
            },
          ),
        upsertHeartbeat: async (input) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT,
            input,
          ),
        runHeartbeat: async (conversationId) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT, {
            conversationId,
          }),
      },
      // Store agent moved to backend — no local agent surface.
      selfModMonitor: {
        getBaselineHead: getGitHead,
        detectAppliedSince: detectSelfModAppliedSince,
      },
      selfModHmrController,
      selfModLifecycle: {
        beginRun: async ({
          runId,
          rootRunId,
          taskDescription,
          packageId,
          releaseNumber,
          mode,
        }) => {
          selfModRunRootIds.set(runId, rootRunId ?? runId);
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
          await storeModService.beginSelfModRun({
            runId,
            taskDescription,
            packageId,
            releaseNumber,
            applyMode: mode,
          });
        },
        finalizeRun: async ({
          runId,
          succeeded,
          conversationId,
          commitMessageProvider,
        }) => {
          // Git commit happens BEFORE the apply so the overlay's
          // "read from disk at apply time" sees the post-commit content.
          // (For most cases the disk hasn't moved between write and
          // commit, but this ordering is cheaper to reason about than
          // racing them.)
          await storeModService.finalizeSelfModRun({
            runId,
            succeeded,
            ...(conversationId ? { conversationId } : {}),
            ...(commitMessageProvider ? { commitMessageProvider } : {}),
          });

          if (!selfModHmrController.hasRun(runId)) {
            // Run was never registered with the contention tracker
            // (e.g., the orchestrator skipped tracking for this run).
            // Nothing to apply — just release the reload pause that
            // beginRun installed.
            await selfModHmrController.releaseRuns([runId]).catch((error) => {
              console.warn(
                "[self-mod-hmr] Failed to release Vite client update pause:",
                (error as Error).message,
              );
            });
            await releaseRuntimeReloadFor([runId]);
            selfModRunRootIds.delete(runId);
            return;
          }

          const decision = selfModHmrController.finalize(runId);
          if (decision.appliedRuns.length === 0) {
            if (!selfModHmrController.hasRun(runId)) {
              // The run finalized with no tracked source writes. There is
              // no renderer batch to apply, but beginRun still installed a
              // runtime-reload pause that must be released.
              await selfModHmrController.releaseRuns([runId]).catch((error) => {
                console.warn(
                  "[self-mod-hmr] Failed to release Vite client update pause:",
                  (error as Error).message,
                );
              });
              await releaseRuntimeReloadFor([runId]);
              selfModRunRootIds.delete(runId);
              return;
            }
            // Run is held — another active run still owns at least one
            // touched path. Reload pause stays in place; it'll be
            // released once the held batch finally drains and applies.
            return;
          }
          await dispatchApplyBatch(decision);
        },
        cancelRun: async (runId) => {
          storeModService.cancelSelfModRun(runId);

          if (!selfModHmrController.hasRun(runId)) {
            await selfModHmrController.releaseRuns([runId]).catch((error) => {
              console.warn(
                "[self-mod-hmr] Failed to release Vite client update pause:",
                (error as Error).message,
              );
            });
            await releaseRuntimeReloadFor([runId]);
            selfModRunRootIds.delete(runId);
            return;
          }

          // Cancel may drain held runs whose only blocker was this one.
          // Apply the drained batch under a morph cover, then release
          // this run's pause separately (cancel is not part of the apply
          // batch — it discards its writes rather than apply them).
          const cancelResult = await selfModHmrController.cancel(runId);
          await releaseRuntimeReloadFor([runId]);
          selfModRunRootIds.delete(runId);
          await dispatchApplyBatch(cancelResult);
        },
      },
      stellaBrowserBinPath: resolveDesktopCliEntrypoint(
        init.stellaRoot,
        "stella-browser",
        "stella-browser.js",
      ),
      stellaOfficeBinPath: resolveDesktopCliEntrypoint(
        init.stellaRoot,
        "stella-office",
        "stella-office.js",
      ),
      stellaUiCliPath: resolveRuntimeCliPath("stella-ui.js"),
      stellaComputerCliPath: resolveRuntimeCliPath("stella-computer.js"),
      onGoogleWorkspaceAuthRequired: () => {
        peer.notify(NOTIFICATION_NAMES.GOOGLE_WORKSPACE_AUTH_REQUIRED, null);
      },
      featureRosterProvider: async () =>
        await buildFeatureRoster({
          repoRoot: init.stellaRoot,
          store: storeModStore,
        }),
    };

    const runner = createStellaHostRunner(runnerOptions);
    state.runner = runner;
    runner.setConvexUrl(init.convexUrl);
    runner.setConvexSiteUrl(init.convexSiteUrl);
    runner.setAuthToken(init.authToken);
    runner.setHasConnectedAccount(init.hasConnectedAccount);
    runner.setCloudSyncEnabled(init.cloudSyncEnabled);
    runner.start();
    await runner.waitUntilInitialized();

    const socialSessionService = new SocialSessionService({
      getWorkspaceRoot: () => init.stellaWorkspacePath,
      getDeviceId: () => state.deviceId,
      getRunner: () => state.runner,
      getChatStore: () => state.chatStore,
      getStore: () => state.socialSessionStore,
      onLocalChatUpdated: () => {
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      },
      pushDisplayPayload: (payload) => {
        // Forward the structured display payload through the existing
        // host display update bridge. The renderer normalizes it via
        // `normalizeDisplayPayload` and routes it to the workspace panel.
        void peer
          .request(METHOD_NAMES.HOST_DISPLAY_UPDATE, { payload })
          .catch(() => undefined);
      },
    });
    socialSessionService.setConvexUrl(init.convexUrl);
    socialSessionService.setAuthToken(init.authToken);
    state.socialSessionService = socialSessionService;

    state.voiceService = new VoiceRuntimeService({
      getRunner: () => state.runner,
      getChatStore: () => state.chatStore,
      getDeviceId: () => state.deviceId,
      onLocalChatUpdated: () => {
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      },
      emitAgentEvent: (payload) => {
        emitVoiceAgentEvent(payload);
      },
      emitSelfModHmrState: (payload) => {
        emitVoiceSelfModHmrState(payload);
      },
    });

    return {
      pid: process.pid,
      deviceId: state.deviceId,
    };
  };

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
    async (params) => {
      const result = await initializeWorker(
        params as WorkerInitializationState,
      );
      if (pendingConfigPatch) {
        applyConfigPatch(pendingConfigPatch);
        pendingConfigPatch = null;
      }
      return result;
    },
  );

  let pendingConfigPatch: Partial<WorkerInitializationState> | null = null;

  const applyConfigPatch = (patch: Partial<WorkerInitializationState>) => {
    if (!state.init) return;
    state.init = { ...state.init, ...patch };
    if (patch.convexUrl !== undefined) {
      state.runner?.setConvexUrl(patch.convexUrl);
      state.socialSessionService?.setConvexUrl(patch.convexUrl);
    }
    if (patch.convexSiteUrl !== undefined) {
      state.runner?.setConvexSiteUrl(patch.convexSiteUrl);
    }
    if (patch.authToken !== undefined) {
      state.runner?.setAuthToken(patch.authToken);
      state.socialSessionService?.setAuthToken(patch.authToken);
    }
    if (patch.hasConnectedAccount !== undefined) {
      state.runner?.setHasConnectedAccount(patch.hasConnectedAccount);
    }
    if (patch.cloudSyncEnabled !== undefined) {
      state.runner?.setCloudSyncEnabled(patch.cloudSyncEnabled);
    }
  };

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CONFIGURE,
    async (params) => {
      const patch = params as Partial<WorkerInitializationState>;
      if (!state.init) {
        // Queue the patch — it will be applied after initialization
        pendingConfigPatch = { ...pendingConfigPatch, ...patch };
        return { ok: true, queued: true };
      }
      applyConfigPatch(patch);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_HEALTH, async () => {
    const health =
      state.runner?.agentHealthCheck() ??
      ({ ready: false } satisfies AgentHealth);
    const socialSessions =
      state.socialSessionService?.getSnapshot() ??
      createEmptySocialSessionServiceSnapshot();
    return {
      health,
      activeRun: state.runner?.getActiveOrchestratorRun() ?? null,
      activeAgentCount: state.runner?.getActiveAgentCount() ?? 0,
      pid: process.pid,
      deviceId: state.deviceId,
      voiceBusy: state.voiceService?.isBusy() ?? false,
      pendingVoiceRequestCount:
        state.voiceService?.getPendingRequestCount() ?? 0,
      socialSessions,
    };
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_ACTIVE,
    async () => {
      return ensureRunner().getActiveOrchestratorRun();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_START_CHAT,
    async (params) => {
      const payload = params as RuntimeChatPayload;
      const requestId =
        asTrimmedString(
          (payload as RuntimeChatPayload & { requestId?: string }).requestId,
        ) || undefined;
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
      );
      const modelImageAttachments = materializedImageAttachments.map(
        ({ attachment }) => attachment,
      );
      const storedAttachments = replaceStoredImageAttachments(
        payload.attachments,
        materializedImageAttachments,
      );
      const {
        visibleUserPrompt,
        windowContextLabel,
        promptMessages,
        windowScreenshotAttachment,
      } = buildChatPromptMessages({
        userPrompt: payload.userPrompt,
        selectedText:
          payload.selectedText ?? payload.chatContext?.selectedText ?? null,
        chatContext: payload.chatContext ?? null,
        explicitImageAttachmentCount: modelImageAttachments.length,
      });
      const userMessageTimestamp = Date.now();
      const windowPreviewImageUrl = windowScreenshotAttachment?.url;
      const userMessageEvent = ensureChatStore().appendEvent({
        conversationId: payload.conversationId,
        type: "user_message",
        deviceId: payload.deviceId,
        timestamp: userMessageTimestamp,
        payload: prepareStoredLocalChatPayload({
          type: "user_message",
          payload: {
            text: visibleUserPrompt,
            ...(storedAttachments?.length
              ? { attachments: storedAttachments }
              : {}),
            ...(payload.platform ? { platform: payload.platform } : {}),
            ...(payload.timezone ? { timezone: payload.timezone } : {}),
            ...(payload.messageMetadata ||
            windowContextLabel ||
            windowPreviewImageUrl
              ? {
                  metadata: {
                    ...(payload.messageMetadata ?? {}),
                    ...(windowContextLabel || windowPreviewImageUrl
                      ? {
                          context: {
                            ...(payload.messageMetadata?.context ?? {}),
                            ...(windowContextLabel
                              ? {
                                  windowLabel: windowContextLabel,
                                }
                              : {}),
                            ...(windowPreviewImageUrl
                              ? {
                                  windowPreviewImageUrl,
                                }
                              : {}),
                          },
                        }
                      : {}),
                  },
                }
              : {}),
            ...(payload.mode ? { mode: payload.mode } : {}),
          },
          timestamp: userMessageTimestamp,
          timezone: payload.timezone,
        }),
      });
      peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);

      const userMessageId = userMessageEvent._id;
      let activeRunId = "";
      let syntheticSeq = 1;
      const hiddenSystemRunIds = new Set<string>();
      let lastVisibleRunId = "";
      let lastVisibleRequestId = requestId;
      const mergedAttachments = [
        ...modelImageAttachments,
        ...(windowScreenshotAttachment ? [windowScreenshotAttachment] : []),
      ];
      logger.info("startChat.prompt-shape", {
        conversationId: payload.conversationId,
        visibleUserPrompt,
        windowContextLabel,
        promptMessages: (promptMessages ?? []).map((message, index) => ({
          index,
          uiVisibility: message.uiVisibility ?? "visible",
          textPreview: message.text.slice(0, 200),
        })),
        incomingAttachmentCount: payload.attachments?.length ?? 0,
        modelImageAttachmentCount: modelImageAttachments.length,
        mergedAttachmentCount: mergedAttachments.length,
        hasWindowScreenshotAttachment: Boolean(windowScreenshotAttachment),
      });
      const result = await ensureRunner().handleLocalChat(
        {
          conversationId: payload.conversationId,
          userMessageId,
          userPrompt: visibleUserPrompt,
          ...(promptMessages?.length ? { promptMessages } : {}),
          attachments:
            mergedAttachments.length > 0 ? mergedAttachments : undefined,
          agentType: payload.agentType,
          storageMode: payload.storageMode,
        },
        {
          onRunStarted: (ev) => {
            activeRunId = ev.runId;
            const isHiddenRun = ev.uiVisibility === "hidden";
            if (isHiddenRun) {
              hiddenSystemRunIds.add(ev.runId);
              if (lastVisibleRunId && ev.responseTarget) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
                  conversationId: payload.conversationId,
                  uiVisibility: "visible",
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            lastVisibleRunId = ev.runId;
            lastVisibleRequestId = requestId;
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onUserMessage: (ev) => {
            if (ev.uiVisibility === "hidden") {
              return;
            }
            ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "user_message",
              requestId: ev.userMessageId,
              timestamp: ev.timestamp,
              payload: prepareStoredLocalChatPayload({
                type: "user_message",
                payload: {
                  text: ev.text,
                  metadata: {
                    ui: {
                      visibility: ev.uiVisibility ?? "visible",
                    },
                  },
                },
                timestamp: ev.timestamp,
                timezone: payload.timezone,
              }),
            });
            peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
          },
          onStream: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  type: AGENT_STREAM_EVENT_TYPES.STREAM,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.STREAM,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onStatus: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  type: AGENT_STREAM_EVENT_TYPES.STATUS,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.STATUS,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onToolStart: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              return;
            }
            ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "tool_request",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                ...(ev.args ? { args: ev.args } : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
              },
            });
            peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onToolEnd: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              return;
            }
            const details =
              ev.details && typeof ev.details === "object"
                ? (ev.details as Record<string, unknown>)
                : undefined;
            ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "tool_result",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                result: details ?? ev.resultPreview,
                resultPreview: ev.resultPreview,
                ...(details ? details : {}),
                ...(ev.fileChanges?.length
                  ? { fileChanges: ev.fileChanges }
                  : {}),
                ...(ev.producedFiles?.length
                  ? { producedFiles: ev.producedFiles }
                  : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
              },
            });
            peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
            });
          },
          onError: (ev) => {
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            hiddenSystemRunIds.delete(ev.runId);
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                  reason: ev.error,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
              reason: ev.error,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              ...(ev.runId ? { rootRunId: ev.runId } : {}),
            });
          },
          onAgentEvent: (ev) => {
            if (!ev.rootRunId) {
              logger.warn("task-event-missing-root-run-id", {
                conversationId: ev.conversationId,
                agentId: ev.agentId,
                type: ev.type,
              });
              return;
            }
            if (
              ev.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED &&
              ev.agentType === AGENT_IDS.GENERAL
            ) {
              const notificationText =
                ev.description?.trim() || "Task complete";
              void peer
                .request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
                  title: notificationText,
                  body: "",
                  sound: "Glass",
                })
                .catch((error) => {
                  logger.debug("agent-completion-notification-failed", {
                    conversationId: payload.conversationId,
                    agentId: ev.agentId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                });
            }
            emitRunEvent({
              type: ev.type,
              runId: ev.rootRunId,
              seq: syntheticSeq++,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              userMessageId,
              agentId: ev.agentId,
              rootRunId: ev.rootRunId,
              agentType: ev.agentType,
              description: ev.description,
              parentAgentId: ev.parentAgentId,
              result: ev.result,
              error: ev.error,
              statusText: ev.statusText,
            });
          },
          onAgentReasoning: (ev) => {
            if (!ev.agentId) {
              return;
            }
            const runId = ev.rootRunId ?? ev.runId;
            emitRunEvent({
              type: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
              runId,
              seq: syntheticSeq++,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              userMessageId,
              agentId: ev.agentId,
              rootRunId: runId,
              agentType: ev.agentType,
              chunk: ev.chunk,
            });
          },
          onEnd: (ev) => {
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            hiddenSystemRunIds.delete(ev.runId);
            const finalText =
              typeof ev.finalText === "string" ? ev.finalText : "";
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
              AGENT_IDS.ORCHESTRATOR
            ) {
              persistAssistantMessage({
                conversationId: payload.conversationId,
                text: finalText,
                userMessageId: ev.userMessageId,
                timezone: payload.timezone,
                responseTarget: ev.responseTarget,
              });
            }
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            emitRunEvent({
              ...ev,
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              ...(ev.runId ? { rootRunId: ev.runId } : {}),
            });
          },
          onInterrupted: (ev) => {
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            hiddenSystemRunIds.delete(ev.runId);
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                  runId: lastVisibleRunId,
                  seq: Number.MAX_SAFE_INTEGER,
                  conversationId: payload.conversationId,
                  ...(lastVisibleRequestId
                    ? { requestId: lastVisibleRequestId }
                    : {}),
                  agentType: ev.agentType,
                  outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
                  reason: ev.reason,
                  rootRunId: lastVisibleRunId,
                });
              }
              return;
            }
            emitRunEvent({
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              runId: ev.runId,
              seq: Number.MAX_SAFE_INTEGER,
              conversationId: payload.conversationId,
              ...(requestId ? { requestId } : {}),
              agentType: ev.agentType,
              userMessageId: ev.userMessageId,
              outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
              reason: ev.reason,
              rootRunId: ev.runId,
            });
          },
          onSelfModHmrState: (statePayload) =>
            emitSelfModHmrState({
              runId: activeRunId || undefined,
              state: statePayload,
            }),
        },
      );
      activeRunId = result.runId;
      return { ...result, userMessageId };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        threadId?: string;
        message?: string;
        interrupt?: boolean;
        metadata?: Record<string, unknown>;
      };
      const conversationId = asTrimmedString(payload.conversationId);
      const threadId = asTrimmedString(payload.threadId);
      const message = asTrimmedString(payload.message);
      if (!conversationId) {
        throw new Error("conversationId is required.");
      }
      if (!threadId) {
        throw new Error("threadId is required.");
      }
      if (!message) {
        throw new Error("message is required.");
      }

      const delivered = await ensureRunner().executeTool(
        "send_input",
        {
          thread_id: threadId,
          message,
          interrupt: payload.interrupt !== false,
        },
        {
          conversationId,
          deviceId: state.deviceId ?? "local",
          requestId: `agent-input:${crypto.randomUUID()}`,
          agentType: AGENT_IDS.ORCHESTRATOR,
          storageMode: "local",
        },
      );
      if (delivered.error) {
        throw new Error(delivered.error);
      }

      const metadata =
        payload.metadata && typeof payload.metadata === "object"
          ? payload.metadata
          : {};
      const uiMetadata =
        metadata.ui && typeof metadata.ui === "object"
          ? (metadata.ui as Record<string, unknown>)
          : {};
      const timestamp = Date.now();
      ensureChatStore().appendEvent({
        conversationId,
        type: "user_message",
        timestamp,
        payload: prepareStoredLocalChatPayload({
          type: "user_message",
          payload: {
            text: message,
            metadata: {
              ...metadata,
              ui: {
                ...uiMetadata,
                visibility: "hidden",
              },
            },
          },
          timestamp,
        }),
      });
      peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      return { delivered: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CANCEL,
    async (params) => {
      ensureRunner().cancelLocalChat((params as { runId: string }).runId);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
    async (params) => {
      return await ensureRunner().runAutomationTurn(
        params as {
          conversationId: string;
          userPrompt: string;
          agentType?: string;
          toolWorkspaceRoot?: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT,
    async (params) => {
      const payload = params as RuntimeLocalAgentRequest;
      return await ensureRunner().runBlockingLocalAgent({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT,
    async (params) => {
      const payload = params as RuntimeLocalAgentRequest;
      return await ensureRunner().createBackgroundAgent({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT,
    async (params) => {
      return await ensureRunner().getLocalAgentSnapshot(
        (params as { agentId: string }).agentId,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE,
    async (params) => {
      ensureRunner().appendThreadMessage(
        params as {
          threadKey: string;
          role: "user" | "assistant";
          content: string;
        },
      );
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH,
    async (params) => {
      const payload = params as {
        query: string;
        category?: string;
        displayResults?: boolean;
      };
      return await ensureRunner().webSearch(payload.query, {
        category: payload.category,
        displayResults: payload.displayResults,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT,
    async (params) => {
      return ensureVoiceService().persistTranscript(
        params as {
          conversationId: string;
          role: "user" | "assistant";
          text: string;
          uiVisibility?: "visible" | "hidden";
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT,
    async (params) => {
      return await ensureVoiceService().orchestratorChat(
        params as {
          requestId: string;
          conversationId: string;
          message: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_WEB_SEARCH,
    async (params) => {
      return await ensureVoiceService().webSearch(
        params as {
          query: string;
          category?: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES,
    async () => {
      return await ensureRunner().listStorePackages();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE,
    async (params) => {
      return await ensureRunner().getStorePackage(
        (params as { packageId: string }).packageId,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES,
    async (params) => {
      return await ensureRunner().listStorePackageReleases(
        (params as { packageId: string }).packageId,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE,
    async (params) => {
      const payload = params as { packageId: string; releaseNumber: number };
      return await ensureRunner().getStorePackageRelease(
        payload.packageId,
        payload.releaseNumber,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CREATE_FIRST_STORE_RELEASE,
    async (params) =>
      await ensureRunner().createFirstStoreRelease(params as StorePublishArgs),
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CREATE_STORE_RELEASE_UPDATE,
    async (params) =>
      await ensureRunner().createStoreReleaseUpdate(params as StorePublishArgs),
  );

  // Backend Store agent owns publishing now. The runtime's only job is to
  // produce the local bundle (commit metadata + patches + file snapshots)
  // for a hand-picked commit selection — the renderer ships that directly
  // to Convex `data.store_thread.confirmDraft`.
  peer.registerRequestHandler(
    METHOD_NAMES.STORE_THREAD_BUILD_BUNDLE,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { commitHashes: string[] };
      const service = ensureStoreModService();
      const candidate = await service.buildPublishCandidateBundle({
        requestText: "store-thread-confirm",
        selectedCommitHashes: payload.commitHashes,
      });
      // Capture HEAD as the `authoredAgainst.stellaCommit` hint. Used by
      // the install agent to know what surface area this release was
      // built against — best-effort, ignored on failure.
      let stellaCommit: string | null = null;
      try {
        stellaCommit = await getGitHead(state.init.stellaRoot);
      } catch {
        stellaCommit = null;
      }
      // Snapshot the user's *currently installed* version of each
      // parent add-on referenced by `Stella-Parent-Package-Id`
      // trailers. The backend prefers this over a fresh "latest"
      // lookup so the published manifest records the release the
      // change was actually authored against — not whatever happens
      // to be the latest on the store at publish time.
      const parentSlugs = new Set<string>();
      for (const commit of candidate.commits) {
        const trailers = parseStellaCommitTrailers(commit.body);
        for (const slug of trailers.parentPackageIds) {
          if (slug) parentSlugs.add(slug);
        }
      }
      const installedParents: Array<{ packageId: string; releaseNumber: number }> = [];
      for (const slug of parentSlugs) {
        const installed = service.getInstalledModByPackageId(slug);
        if (installed && installed.state === "installed") {
          installedParents.push({
            packageId: slug,
            releaseNumber: installed.releaseNumber,
          });
        }
      }
      return {
        commits: candidate.commits,
        files: candidate.files,
        ...(stellaCommit ? { stellaCommit } : {}),
        ...(installedParents.length > 0 ? { installedParents } : {}),
      };
    },
  );

  // Feature roster reader: the side panel calls into this on mount and
  // whenever it wants a fresh view. Same builder the commit-message LLM
  // uses on the commit hot path, so the UI shows exactly what the
  // grouping decision saw.
  peer.registerRequestHandler(
    METHOD_NAMES.STORE_THREAD_LIST_FEATURE_ROSTER,
    async () => {
      if (!state.init || !state.storeModStore) {
        throw new Error("Worker has not been initialized.");
      }
      return await buildFeatureRoster({
        repoRoot: state.init.stellaRoot,
        store: state.storeModStore,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_INSTALL_STORE_RELEASE,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { packageId: string; releaseNumber?: number };
      const runner = ensureRunner();
      const service = ensureStoreModService();
      const requestedReleaseNumber =
        typeof payload.releaseNumber === "number" &&
        Number.isFinite(payload.releaseNumber)
          ? Math.max(1, Math.floor(payload.releaseNumber))
          : undefined;
      const availableReleases = await runner.listStorePackageReleases(
        payload.packageId,
      );
      if (!requestedReleaseNumber && availableReleases.length === 0) {
        throw new Error(
          `Package "${payload.packageId}" has no published releases.`,
        );
      }
      const releaseNumber =
        requestedReleaseNumber ??
        Math.max(1, ...availableReleases.map((entry) => entry.releaseNumber));

      const result = await service.installRelease({
        packageId: payload.packageId,
        releaseNumber,
        fetchRelease: async ({ packageId, releaseNumber }) => {
          const release = await runner.getStorePackageRelease(
            packageId,
            releaseNumber,
          );
          const packageRecord = await runner.getStorePackage(packageId);
          if (!release || !packageRecord) {
            throw new Error("Store release not found.");
          }
          if (!release.artifactUrl) {
            throw new Error("Store release artifact URL is unavailable.");
          }
          const response = await fetch(release.artifactUrl);
          if (!response.ok) {
            throw new Error(
              `Failed to download release artifact (${response.status}).`,
            );
          }
          const artifact = (await response.json()) as StoreReleaseArtifact;
          return {
            package: packageRecord,
            release,
            artifact,
          };
        },
        applyRelease: async ({
          package: packageRecord,
          release,
          artifact,
          mode,
        }) => {
          const blueprintPath = await writeBlueprintArtifact({
            stellaRoot: state.init!.stellaRoot,
            packageId: packageRecord.packageId,
            releaseNumber: release.releaseNumber,
            artifact,
          });
          const blockingAgentResult = await runner.runBlockingLocalAgent({
            conversationId: `store:${packageRecord.packageId}`,
            description: `${mode === "update" ? "Update" : "Install"} ${packageRecord.displayName} from store`,
            prompt: buildStoreInstallPrompt({
              blueprintPath,
              packageRecord,
              release,
              mode,
            }),
            agentType: "general",
            selfModMetadata: {
              packageId: packageRecord.packageId,
              releaseNumber: release.releaseNumber,
              mode,
            },
          });
          if (blockingAgentResult.status !== "ok") {
            throw new Error(blockingAgentResult.error);
          }
        },
      });
      return result.installRecord;
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_UNINSTALL_STORE_MOD,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { packageId: string };
      const service = ensureStoreModService();
      const install = service.getInstalledModByPackageId(payload.packageId);
      if (!install || install.state === "uninstalled") {
        return {
          packageId: payload.packageId,
          revertedCommits: [],
        };
      }
      const revertedCommits = await revertGitCommits({
        repoRoot: state.init.stellaRoot,
        commitHashes: [...install.applyCommitHashes].reverse(),
      });
      service.markInstallUninstalled(install.installId);
      return {
        packageId: payload.packageId,
        revertedCommits,
      };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR,
    async (params) => {
      // Repurposed for the contended-apply pipeline: this is the host's
      // signal that the morph cover for `transitionId` is on screen and
      // we can safely run the actual overlay apply + release the
      // runtime-reload pauses. The single-run `resume` API is gone.
      const payload = params as
        | { transitionId?: string; runIds?: string[]; options?: ApplyOptions }
        | undefined;
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
        logSelfModHmrWorker("resume:unknownTransition", {
          transitionId,
          staleRunIds,
        });
        await releaseRuntimeReloadFor(staleRunIds);
        return { ok: false, reason: "unknown-transition" as const };
      }
      logSelfModHmrWorker("resume:start", {
        transitionId,
        runIds: pending.applyResult.restartRelevantRunIds,
        requiresFullReload: pending.requiresFullReload,
        options: payload?.options,
      });
      const controller = state.selfModHmrController;
      const applyResponse: HmrApplyResponse = controller
        ? await controller
            .apply(pending.applyResult.appliedRuns, payload?.options)
            .catch(() => ({ ok: false }))
        : { ok: false };
      if (!applyResponse.ok) {
        logSelfModHmrWorker("resume:applyFailed", {
          transitionId,
          requiresFullReload: pending.requiresFullReload,
        });
        console.warn(
          "[self-mod-hmr] Apply failed; discarding Vite self-mod state before releasing runtime reload pause.",
        );
        await discardFailedApplyState(pending.applyResult, "apply failure");
        pendingApplyBatches.delete(transitionId);
        await releaseRuntimeReloadFor(
          pending.applyResult.restartRelevantRunIds,
          { allowDeferredReload: pending.requiresFullReload },
        );
        for (const runId of pending.applyResult.restartRelevantRunIds) {
          selfModRunRootIds.delete(runId);
        }
        return { ok: false, reason: "apply-failed" as const };
      }
      pendingApplyBatches.delete(transitionId);
      await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
        allowDeferredReload: pending.requiresFullReload,
      });
      for (const runId of pending.applyResult.restartRelevantRunIds) {
        selfModRunRootIds.delete(runId);
      }
      logSelfModHmrWorker("resume:done", {
        transitionId,
        requiresFullReload: pending.requiresFullReload,
        requiresClientFullReload:
          applyResponse.requiresClientFullReload === true,
      });
      return {
        ok: true,
        requiresClientFullReload: applyResponse.requiresClientFullReload === true,
      };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS,
    async () => {
      ensureRunner().killAllShells();
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    async () => {
      return ensureChatStore().getOrCreateDefaultConversationId();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT,
    async (params) => {
      ensureChatStore().appendEvent(
        params as {
          conversationId: string;
          type: string;
          payload?: unknown;
          requestId?: string;
          targetDeviceId?: string;
          deviceId?: string;
          timestamp?: number;
          eventId?: string;
          channelEnvelope?: unknown;
        },
      );
      peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        maxItems?: number;
        windowBy?: "events" | "visible_messages";
      };
      return ensureChatStore().listEvents(
        payload.conversationId ?? "",
        payload.maxItems,
        payload.windowBy,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        countBy?: "events" | "visible_messages";
      };
      return ensureChatStore().getEventCount(
        payload.conversationId ?? "",
        payload.countBy,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        message?: string;
        suggestions?: unknown[];
      };
      const conversationId = payload.conversationId ?? "";
      const message =
        typeof payload.message === "string" ? payload.message : "";
      if (message.trim().length > 0) {
        ensureChatStore().appendEvent({
          conversationId,
          type: "assistant_message",
          payload: prepareStoredLocalChatPayload({
            type: "assistant_message",
            payload: { text: message },
            timestamp: Date.now(),
          }),
        });
      }
      const suggestions = Array.isArray(payload.suggestions)
        ? payload.suggestions
        : [];
      if (suggestions.length > 0) {
        ensureChatStore().appendEvent({
          conversationId,
          type: "home_suggestions",
          payload: { suggestions },
        });
      }
      peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      return { ok: true as const };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        maxMessages?: number;
      };
      return ensureChatStore().listSyncMessages(
        payload.conversationId ?? "",
        payload.maxMessages,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT,
    async (params) => {
      return ensureChatStore().getSyncCheckpoint(
        (params as { conversationId?: string }).conversationId ?? "",
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        localMessageId?: string;
      };
      ensureChatStore().setSyncCheckpoint(
        payload.conversationId ?? "",
        payload.localMessageId ?? "",
      );
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload =
        (params as
          | { selectedBrowser?: string; selectedProfile?: string }
          | undefined) ?? {};
      const data = await collectBrowserData(state.init.stellaRoot, {
        selectedBrowser: payload.selectedBrowser as
          | import("../discovery/browser-data.js").BrowserType
          | undefined,
        selectedProfile: payload.selectedProfile,
      });
      return { data, formatted: formatBrowserDataForSynthesis(data) };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload =
        (params as
          | {
              categories?: string[];
              selectedBrowser?: string;
              selectedProfile?: string;
            }
          | undefined) ?? {};
      return await collectAllSignals(
        state.init.stellaRoot,
        payload.categories as
          | import("../../desktop/src/shared/contracts/discovery.js").DiscoveryCategory[]
          | undefined,
        payload.selectedBrowser,
        payload.selectedProfile,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_LOCAL_COMMITS,
    async (params) => {
      return await ensureStoreModService().listLocalCommits(
        (params as { limit?: number } | undefined)?.limit,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_LOCAL_COMMITS_BY_SELECTOR,
    async (params) => {
      const args =
        (params as
          | { featureIds?: string[]; commitHashes?: string[] }
          | undefined) ?? {};
      return await ensureStoreModService().listLocalCommitsBySelector({
        ...(args.featureIds ? { featureIds: args.featureIds } : {}),
        ...(args.commitHashes ? { commitHashes: args.commitHashes } : {}),
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED,
    async () => {
      return ensureStoreModService().listInstalledMods();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as { roomId?: string; workspaceLabel?: string };
      const roomId = asTrimmedString(payload?.roomId);
      if (!roomId) {
        throw new Error("Room ID is required.");
      }
      return await state.socialSessionService.createSession({
        roomId,
        workspaceLabel: asTrimmedString(payload?.workspaceLabel) || undefined,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as {
        sessionId?: string;
        status?: "active" | "paused" | "ended";
      };
      const sessionId = asTrimmedString(payload?.sessionId);
      if (!sessionId) {
        throw new Error("Session ID is required.");
      }
      const status = payload?.status;
      if (status !== "active" && status !== "paused" && status !== "ended") {
        throw new Error("Session status is invalid.");
      }
      return await state.socialSessionService.updateSessionStatus({
        sessionId,
        status,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as {
        sessionId?: string;
        prompt?: string;
        agentType?: string;
        clientTurnId?: string;
      };
      const sessionId = asTrimmedString(payload?.sessionId);
      const prompt = asTrimmedString(payload?.prompt);
      if (!sessionId) {
        throw new Error("Session ID is required.");
      }
      if (!prompt) {
        throw new Error("Prompt is required.");
      }
      return await state.socialSessionService.queueTurn({
        sessionId,
        prompt,
        agentType: asTrimmedString(payload?.agentType) || undefined,
        clientTurnId: asTrimmedString(payload?.clientTurnId) || undefined,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS,
    async () => {
      return (
        state.socialSessionService?.getSnapshot() ??
        createEmptySocialSessionServiceSnapshot()
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_REVERT,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { featureId?: string; steps?: number };
      return await revertGitFeature({
        repoRoot: state.init.stellaRoot,
        featureId: payload.featureId,
        steps: payload.steps,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_LAST_FEATURE,
    async () => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      return await getLastGitFeatureId(state.init.stellaRoot);
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_RECENT_FEATURES,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const rawLimit = (params as { limit?: number } | undefined)?.limit;
      const limit = Number.isFinite(rawLimit) ? Number(rawLimit) : 8;
      return await listRecentGitFeatures(state.init.stellaRoot, limit);
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT,
    async (params) => {
      ensureRunner().killShellsByPort((params as { port: number }).port);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS,
    async () => {
      return await ensureRunner().googleWorkspaceGetAuthStatus();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT,
    async () => {
      return await ensureRunner().googleWorkspaceConnect();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT,
    async () => {
      return await ensureRunner().googleWorkspaceDisconnect();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DREAM_TRIGGER_NOW,
    async (params) => {
      const trigger =
        (
          params as
            | {
                trigger?:
                  | "manual"
                  | "subagent_finalize"
                  | "chronicle_summary"
                  | "startup_catchup";
              }
            | undefined
        )?.trigger ?? "manual";
      return await ensureRunner().triggerDreamNow(trigger);
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CHRONICLE_SUMMARY_TICK,
    async (params) => {
      const window =
        (params as { window?: "10m" | "6h" } | undefined)?.window ?? "10m";
      return await ensureRunner().runChronicleSummaryTick(window);
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_HEALTH, async () => {
    return {
      ready: Boolean(state.runner?.agentHealthCheck().ready),
      hostPid: process.pid,
      workerPid: process.pid,
      workerRunning: true,
      workerGeneration: 0,
      deviceId: state.deviceId,
      activeRunId: state.runner?.getActiveOrchestratorRun()?.runId ?? null,
      activeAgentCount: state.runner?.getActiveAgentCount() ?? 0,
    };
  });

  const shutdownWorker = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await stopWorkerServices(state);
  };

  process.once("SIGTERM", () => {
    void shutdownWorker().finally(() => {
      process.exit(0);
    });
  });

  process.once("exit", () => {
    void shutdownWorker();
  });
};
