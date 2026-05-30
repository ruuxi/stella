import crypto from "node:crypto";
import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerPeerLike } from "./peer-broker.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type AgentHealth,
  type HostDeviceIdentity,
  type HostAppBrowserContextSnapshot,
  type RuntimeAttachmentRef,
  type RuntimeAgentEventPayload,
  type RuntimeChatPayload,
  type RuntimeOneShotCompletionRequest,
  type RuntimeOneShotCompletionResult,
  type RuntimeSelfModRevertResult,
  type StorePublishArgs,
  type StorePublishSelectedFeaturesArgs,
  type StoreThreadSendInput,
  type RuntimeLocalAgentRequest,
} from "../protocol/index.js";
import type {
  StorePackageReleaseRecord,
  StoreReleaseCommit,
  StoreReleaseSourcePack,
} from "../contracts/index.js";
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
  type AgentRunFinishOutcome,
  type AgentStreamEventType,
} from "../contracts/agent-runtime.js";
import { fileChange } from "../contracts/file-changes.js";
import { prepareStoredLocalChatPayload } from "../kernel/storage/local-chat-payload.js";
import { collectAllSignals } from "../discovery/collect-all.js";
import { sweepStaleConnectorBridgeProcesses } from "../kernel/connectors/process-registry.js";
import {
  collectBrowserData,
  formatBrowserDataForSynthesis,
} from "../discovery/browser-data.js";
import {
  createStellaHostRunner,
  type StellaHostRunnerOptions,
} from "../kernel/runner.js";
import { runOneShotCompletion } from "../kernel/agent-runtime/one-shot-completion.js";
import { buildChatPromptMessages } from "../kernel/chat-prompt-context.js";
import { getDevServerUrl } from "./dev-url.js";
import {
  startCliBridgeServer,
  type CliBridgeServer,
} from "./cli-bridge-server.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import {
  discardGitDirtyFiles,
  detectSelfModAppliedSince,
  getLastGitFeatureId,
  getGitHead,
  listGitDirtyFiles,
  listFilesForCommit,
  listRecentGitFeatures,
  revertGitFeature,
} from "../kernel/self-mod/git.js";
import {
  createSelfModHmrController,
  deriveApplyTransitionRequirements,
  type ApplyOptions,
  type ApplyResult,
  type HmrApplyResponse,
  type SelfModHmrController,
} from "../kernel/self-mod/hmr.js";
import type { StellaSourcePack } from "../kernel/self-mod/stella-source-control.js";
import { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import { createDesktopDatabase } from "../kernel/storage/database.js";
import { ChatStore } from "../kernel/storage/chat-store.js";
import { RuntimeStore } from "../kernel/storage/runtime-store.js";
import { RunEventLog } from "../kernel/storage/run-event-log.js";
import { StoreModStore } from "../kernel/storage/store-mod-store.js";
import {
  StellaSourceHistoryStore,
  type StellaSourceRevisionOrigin,
} from "../kernel/storage/stella-source-history-store.js";
import type {
  LocalChatEventRecord,
  SqliteDatabase,
} from "../kernel/storage/shared.js";
import { createEmptySocialSessionServiceSnapshot } from "../contracts/index.js";
import { SocialSessionService } from "./social-sessions/service.js";
import { SocialSessionStore } from "./social-sessions/store.js";
import { VoiceRuntimeService } from "./voice/service.js";
import { createRuntimeLogger } from "../kernel/debug.js";

type WorkerInitializationState = {
  protocolVersion?: string;
  stellaRoot: string;
  stellaHomePath: string;
  stellaWorkspacePath: string;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  hasConnectedAccount: boolean;
  cloudSyncEnabled: boolean;
  modelCatalogUpdatedAt: number | null;
};

const notifyLocalChatUpdated = (
  peer: WorkerPeerLike,
  conversationId?: string,
  event?: LocalChatEventRecord,
) => {
  peer.notify(
    NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED,
    event || conversationId
      ? {
          ...(conversationId ? { conversationId } : {}),
          ...(event ? { event } : {}),
        }
      : null,
  );
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
  statusState?: "running" | "compacting" | "provider-retry";
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
  sourceHistoryStore: StellaSourceHistoryStore | null;
  storeModService: StoreModService | null;
  socialSessionStore: SocialSessionStore | null;
  socialSessionService: SocialSessionService | null;
  voiceService: VoiceRuntimeService | null;
  runner: RuntimeRunner | null;
  deviceId: string | null;
  selfModHmrController: SelfModHmrController | null;
  /**
   * Worker-internal handler that wraps `revertGitFeature` with the
   * self-mod HMR lifecycle (snapshot pre-revert files, register run,
   * `dispatchApplyBatch` for the morph cover + reload tiering).
   * Declared inside `initializeWorker` so it has access to the
   * closure-scoped `dispatchApplyBatch` + `releaseRuntimeReloadFor`;
   * stored on `state` so the module-level
   * `INTERNAL_WORKER_SELF_MOD_REVERT` handler can call it.
   */
  revertSelfModWithMorph:
    | ((args: {
        featureId?: string;
        steps?: number;
      }) => Promise<RuntimeSelfModRevertResult>)
    | null;
  beginExternalSelfModWithMorph:
    | ((args: { runId: string; paths: string[] }) => Promise<{ ok: true }>)
    | null;
  finishExternalSelfModWithMorph:
    | ((args: { runId: string; succeeded: boolean }) => Promise<{ ok: true }>)
    | null;
  activeStoreThreadAgentId: string | null;
  activeStoreThreadMessageId: string | null;
  /**
   * Persistent ring buffer for streaming run events. Every event we emit
   * via NOTIFICATION_NAMES.RUN_EVENT also gets persisted here so that a
   * reconnecting host (post-Electron-restart, post-mini-window-open, etc.)
   * can replay anything past its `lastSeq` without losing in-flight work.
   * See runtime/kernel/storage/run-event-log.ts.
   */
  runEventLog: RunEventLog | null;
  /**
   * UDS bridge the worker exposes for sidecar CLIs (`stella-connect`)
   * that need to call back into the host without speaking the full
   * runtime JSON-RPC protocol. Started on first init, restarted if
   * the worker re-inits with a new stellaRoot, stopped on shutdown.
   * See `cli-bridge-server.ts`.
   */
  cliBridgeServer: CliBridgeServer | null;
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

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

import {
  STORE_THREAD_CONVERSATION_ID,
  buildStoreReleaseRedactor,
  buildStoreThreadAgentPrompt,
  collectStoreReleaseCommits,
  collectStoreReleaseSourcePack,
  extractBlueprintMarkdown,
  normalizeStoreThreadFeatureNames,
  normalizeStoreThreadText,
} from "./store-thread-helpers.js";
import {
  buildStoreInstallPrompt,
  buildStoreInstallReviewPrompt,
  parseStoreInstallReviewDecision,
} from "./store-install-prompt.js";
import {
  assertStoreSourcePackIntegrity,
  selectStoreSourcePackForInstalledRevisions,
} from "./store-source-pack-install.js";

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

const stopWorkerServices = async (state: WorkerState) => {
  state.socialSessionService?.stop();
  state.socialSessionService = null;
  state.voiceService = null;
  state.revertSelfModWithMorph = null;
  // `runner.stop()` now awaits a bounded drain of the background
  // compaction scheduler so SQLite writes complete before we close
  // `state.db`. Without this await, an in-flight `compactThread` could
  // race the `db.close()` below.
  await state.runner?.stop();
  state.runner = null;
  state.chatStore = null;
  state.runtimeStore = null;
  state.storeModStore = null;
  state.sourceHistoryStore = null;
  state.storeModService = null;
  state.socialSessionStore = null;
  state.selfModHmrController = null;
  state.activeStoreThreadAgentId = null;
  state.activeStoreThreadMessageId = null;
  state.runEventLog?.stop();
  state.runEventLog = null;
  await state.cliBridgeServer?.stop().catch(() => undefined);
  state.cliBridgeServer = null;
  state.db?.close();
  state.db = null;
};

export const createRuntimeWorkerServer = (peer: WorkerPeerLike) => {
  let shuttingDown = false;
  const state: WorkerState = {
    init: null,
    db: null,
    chatStore: null,
    runtimeStore: null,
    storeModStore: null,
    sourceHistoryStore: null,
    storeModService: null,
    socialSessionStore: null,
    socialSessionService: null,
    voiceService: null,
    runner: null,
    deviceId: null,
    selfModHmrController: null,
    revertSelfModWithMorph: null,
    beginExternalSelfModWithMorph: null,
    finishExternalSelfModWithMorph: null,
    activeStoreThreadAgentId: null,
    activeStoreThreadMessageId: null,
    runEventLog: null,
    cliBridgeServer: null,
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
    // Persist to the run event log BEFORE emitting on the wire so a host
    // that disconnects mid-notify still sees the event on reconnect.
    // INSERT OR IGNORE collapses (runId, seq) collisions for the rare
    // synthetic terminal markers (e.g. seq=MAX_SAFE_INTEGER) — both copies
    // describe the same terminal state, so retaining the first is fine.
    state.runEventLog?.append({
      runId: event.runId,
      seq: event.seq,
      payload: event as unknown as Record<string, unknown>,
    });
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

  const emitVoiceActionCompleted = (payload: {
    conversationId: string;
    status: "completed" | "failed";
    message: string;
  }) => {
    peer.notify(NOTIFICATION_NAMES.VOICE_ACTION_COMPLETED, payload);
  };

  const hasActiveWork = (): boolean => {
    // Keep this in sync with host-side shouldKeepWorkerAlive plus
    // worker-only work that the host cannot observe after disconnect
    // (active request handlers and pending self-mod apply batches).
    const socialSessions =
      state.socialSessionService?.getSnapshot() ??
      createEmptySocialSessionServiceSnapshot();
    const socialPinned =
      socialSessions.sessionCount > 0 ||
      Boolean(socialSessions.processingTurnId);
    const voicePinned =
      (state.voiceService?.isBusy() ?? false) ||
      (state.voiceService?.getPendingRequestCount() ?? 0) > 0;
    const storePinned = Boolean(state.activeStoreThreadAgentId);
    const requestPinned = (peer.activeRequestHandlerCount?.() ?? 0) > 0;
    const pendingApplyPinned = pendingApplyBatches.size > 0;
    return Boolean(
      state.runner?.getActiveOrchestratorRun() ||
        (state.runner?.getActiveAgentCount() ?? 0) > 0 ||
        requestPinned ||
        pendingApplyPinned ||
        storePinned ||
        socialPinned ||
        voicePinned,
    );
  };

  /**
   * Append a fresh persisted assistant row for one completed assistant
   * message within a run. A Pi orchestrator run may emit several
   * assistant messages (preamble, post-tool answer, …); each gets its
   * own row keyed by `(runId, seq)` so they render linearly in
   * chronological order rather than collapsing into a single
   * `assistant-for-<userMessageId>` row that overwrites itself.
   *
   * Returns the persisted eventId so callers can track the latest row
   * per user turn (e.g. for the `selfModApplied` patch target on
   * `agent_end`).
   */
  const appendAssistantMessageForTurn = (args: {
    conversationId: string;
    text: string;
    userMessageId: string;
    runId: string;
    seq: number;
    timezone?: string;
    responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  }): string | null => {
    const trimmedText = args.text.trim();
    if (!trimmedText) {
      return null;
    }

    const runtimeMetadata = args.responseTarget
      ? {
          runtime: {
            responseTarget: args.responseTarget,
          },
        }
      : undefined;

    const eventId = `assistant-msg-${args.runId}-${args.seq}`;
    const event = ensureChatStore().appendEvent({
      conversationId: args.conversationId,
      eventId,
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
    notifyLocalChatUpdated(peer, args.conversationId, event);
    return eventId;
  };

  /**
   * Patch the persisted assistant message identified by `eventId` with
   * the self-mod commit metadata produced by the `agent_end` hook.
   * Drives the inline "Undo changes" button under the assistant row.
   *
   * Targets the LAST assistant message of the run (tracked in the
   * `startChat` closure as `lastAssistantMessageEventId`) so the undo
   * affordance sits under the post-tool answer rather than under an
   * earlier preamble. If no assistant row was ever written for this
   * run (e.g. empty-text completion), the merge silently no-ops.
   */
  const attachSelfModToAssistantMessage = (args: {
    conversationId: string;
    eventId: string;
    selfModApplied: { featureId: string; files: string[]; batchIndex: number };
  }): void => {
    const updated = ensureChatStore().mergeEventPayload({
      conversationId: args.conversationId,
      eventId: args.eventId,
      patch: { selfModApplied: args.selfModApplied },
    });
    if (updated) {
      notifyLocalChatUpdated(peer, args.conversationId, updated);
    }
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

  const ensureStoreModStore = () => {
    if (!state.storeModStore) {
      throw new Error("Store data is not available.");
    }
    return state.storeModStore;
  };

  const ensureSourceHistoryStore = () => {
    if (!state.sourceHistoryStore) {
      throw new Error("Stella source history is not available.");
    }
    return state.sourceHistoryStore;
  };

  const recordSourcePackHistory = (args: {
    sourcePack: StellaSourcePack;
    packageId?: string;
    releaseNumber?: number;
    origin: StellaSourceRevisionOrigin;
    featureId?: string;
    description?: string;
    commitHash?: string | null;
  }) => {
    const sourceHistory = ensureSourceHistoryStore();
    const lastRevisionId =
      args.sourcePack.changeSets[args.sourcePack.changeSets.length - 1]
        ?.revisionId;
    for (const changeSet of args.sourcePack.changeSets) {
      sourceHistory.recordRevision({
        changeSet,
        origin: args.origin,
        ...(args.packageId ? { packageId: args.packageId } : {}),
        ...(args.releaseNumber != null
          ? { releaseNumber: args.releaseNumber }
          : {}),
        ...(args.commitHash && changeSet.revisionId === lastRevisionId
          ? { commitHash: args.commitHash }
          : {}),
        featureId:
          changeSet.featureId ??
          args.sourcePack.featureId ??
          args.featureId ??
          (args.packageId ? `store:${args.packageId}` : undefined),
        description:
          changeSet.description ??
          args.sourcePack.description ??
          args.description ??
          (args.packageId && args.releaseNumber != null
            ? `${args.packageId} release ${args.releaseNumber}`
            : undefined),
      });
    }
  };

  const reconcileStoreThreadPendingMessages = () => {
    const store = ensureStoreModStore();
    const pending = store
      .listStoreThreadMessages()
      .some((message) => message.pending === true);
    if (pending && !state.activeStoreThreadAgentId) {
      store.clearPendingStoreThreadMessages(
        "The Store agent stopped unexpectedly. Please send your message again.",
      );
    }
    return store;
  };

  const ensureVoiceService = () => {
    if (!state.voiceService) {
      throw new Error("Voice runtime service is not available.");
    }
    return state.voiceService;
  };

  const initializeWorker = async (init: WorkerInitializationState) => {
    if (
      init.protocolVersion &&
      init.protocolVersion !== STELLA_RUNTIME_PROTOCOL_VERSION
    ) {
      throw new Error(
        `Runtime protocol mismatch: host=${init.protocolVersion} worker=${STELLA_RUNTIME_PROTOCOL_VERSION}.`,
      );
    }
    const sameRuntimeRoot =
      state.init?.stellaRoot === init.stellaRoot &&
      state.init?.stellaHomePath === init.stellaHomePath &&
      state.init?.stellaWorkspacePath === init.stellaWorkspacePath;
    if (sameRuntimeRoot && state.runner) {
      applyConfigPatch(init);
      return {
        protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
        pid: process.pid,
        deviceId: state.deviceId,
      };
    }
    await stopWorkerServices(state);
    // Pending self-mod apply batches conceptually belong to the apply
    // pipeline, not the runner. Preserve them across same-root re-inits so
    // a host reattach (e.g., a renderer reload that disrupts IPC briefly)
    // doesn't strand an in-flight HOST_HMR_RUN_TRANSITION → its resume
    // callback can still find the pending entry. Only drop them when the
    // workspace itself changed -- a different root means a different
    // workspace and the pending apply is no longer valid.
    if (!sameRuntimeRoot) {
      await releasePendingApplyBatches("worker initialization");
    }
    const connectorSweep = await sweepStaleConnectorBridgeProcesses(
      init.stellaHomePath,
      { currentWorkerPid: process.pid },
    ).catch((error) => {
      console.warn(
        "[connector-bridge] Failed to sweep stale connector helpers:",
        (error as Error).message,
      );
      return null;
    });
    if (connectorSweep?.stopped) {
      console.warn(
        `[connector-bridge] Stopped ${connectorSweep.stopped} stale connector helper(s).`,
      );
    }
    state.init = init;

    const db = createDesktopDatabase(init.stellaHomePath);
    const chatStore = new ChatStore(db);
    const runtimeStore = chatStore as RuntimeStore;
    const storeModStore = new StoreModStore(db);
    const sourceHistoryStore = new StellaSourceHistoryStore(db);
    const socialSessionStore = new SocialSessionStore(db);
    const storeModService = new StoreModService(
      init.stellaRoot,
      storeModStore,
      sourceHistoryStore,
    );
    const runEventLog = new RunEventLog(db);
    for (const buffered of runEventLog.listBufferedRuns()) {
      if (buffered.hasTerminalEvent) continue;
      runEventLog.append({
        runId: buffered.runId,
        seq: Number.MAX_SAFE_INTEGER,
        payload: {
          type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
          runId: buffered.runId,
          seq: Number.MAX_SAFE_INTEGER,
          conversationId: buffered.conversationId,
          outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
          reason: "worker_restart",
          error: "Stella restarted before this run could finish.",
          rootRunId: buffered.runId,
        },
      });
    }
    runEventLog.startBackgroundSweep();
    const deviceIdentity = await peer.request<HostDeviceIdentity>(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
    );
    state.deviceId = deviceIdentity.deviceId;
    const selfModHmrController = createSelfModHmrController({
      getDevServerUrl,
      enabled: process.env.NODE_ENV === "development",
      repoRoot: init.stellaRoot,
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
    state.sourceHistoryStore = sourceHistoryStore;
    state.storeModService = storeModService;
    state.socialSessionStore = socialSessionStore;
    state.runEventLog = runEventLog;

    // Spin up the CLI bridge socket so sidecar CLIs invoked from
    // `exec_command` (today just `stella-connect`) can call back into
    // the host for credential dialogs. The socket path is injected into
    // PTY shells as `STELLA_CLI_BRIDGE_SOCK` (see runtime/kernel/tools/
    // shell.ts). If startup fails we log + continue — the CLI gracefully
    // falls back to exit-2 `auth_required` when the socket isn't there.
    const bridgePaths = resolveRuntimePaths(init.stellaRoot);
    try {
      state.cliBridgeServer = await startCliBridgeServer({
        socketPath: bridgePaths.cliBridgeSocketPath,
        log: (message, error) => {
          if (error) {
            console.warn(`[cli-bridge] ${message}:`, error);
          } else {
            console.warn(`[cli-bridge] ${message}`);
          }
        },
        handlers: {
          requestConnectorCredential: async (params) => {
            try {
              return await peer.request<
                | { ok: true }
                | {
                    ok: false;
                    reason: "cancelled" | "timeout" | "unsupported" | string;
                  }
              >(METHOD_NAMES.HOST_CONNECTOR_CREDENTIAL_REQUEST, params, {
                retryOnDisconnect: true,
              });
            } catch (error) {
              return {
                ok: false,
                reason: (error as Error).message || "host_unreachable",
              };
            }
          },
          getStellaSiteAuth: () => {
            const baseUrl =
              state.init?.convexSiteUrl?.trim() ?? init.convexSiteUrl?.trim();
            const authToken =
              state.init?.authToken?.trim() ?? init.authToken?.trim();
            if (!baseUrl || !authToken) {
              return { ok: false, reason: "not_signed_in" };
            }
            return { ok: true, baseUrl, authToken };
          },
        },
      });
    } catch (error) {
      console.warn(
        "[cli-bridge] Failed to start CLI bridge server:",
        (error as Error).message,
      );
      state.cliBridgeServer = null;
    }

    // Push a fresh snapshot to subscribers whenever the Store thread mutates
    // (matches the localChat updated-channel pattern). The renderer
    // subscribes via `electronAPI.store.onThreadUpdated` so the side panel
    // never has to poll.
    storeModStore.setThreadUpdatedListener(() => {
      try {
        peer.notify(
          NOTIFICATION_NAMES.STORE_THREAD_UPDATED,
          storeModStore.readStoreThread(),
        );
      } catch (error) {
        console.warn(
          "[store-mod-store] Failed to notify thread update:",
          (error as Error).message,
        );
      }
    });

    // ---- self-mod apply orchestration ----
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
              forceClientFullReload: true,
            })
            .catch(() => ({ ok: false }));
          if (!applyResponse.ok) {
            console.warn(
              "[self-mod-hmr] Direct apply failed; discarding Vite self-mod state before releasing runtime reload pause.",
            );
            await discardFailedApplyState(applyResult, "direct apply failure");
            pendingApplyBatches.delete(transitionId);
            await releaseRuntimeReloadFor(applyResult.restartRelevantRunIds, {
              allowDeferredReload: requiresRuntimeRestart,
            });
            for (const runId of applyResult.restartRelevantRunIds) {
              selfModRunRootIds.delete(runId);
            }
            return;
          }
          pendingApplyBatches.delete(transitionId);
          await releaseRuntimeReloadFor(applyResult.restartRelevantRunIds, {
            allowDeferredReload: requiresRuntimeRestart,
          });
          for (const runId of applyResult.restartRelevantRunIds) {
            selfModRunRootIds.delete(runId);
          }
        }
      }
    };

    const externalSelfModPathsByRun = new Map<string, string[]>();

    state.beginExternalSelfModWithMorph = async ({ runId, paths }) => {
      if (!state.selfModHmrController) {
        throw new Error("Self-mod HMR controller is not initialized.");
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
        await state.selfModHmrController.beginRun(runId);
        const absolutePaths = paths.map((filePath) =>
          path.isAbsolute(filePath)
            ? filePath
            : path.join(init.stellaRoot, filePath),
        );
        if (absolutePaths.length > 0) {
          externalSelfModPathsByRun.set(runId, absolutePaths);
          // Match agent self-mod pre-write tracking: own/pin the paths now,
          // but capture the morph payload only after the external mutation.
          await state.selfModHmrController.recordWrite(runId, absolutePaths, {
            captureSnapshot: false,
          });
        }
        return { ok: true };
      } catch (error) {
        if (state.selfModHmrController.hasRun(runId)) {
          await state.selfModHmrController.cancel(runId).catch(() => undefined);
        }
        await releaseRuntimeReloadFor([runId]);
        selfModRunRootIds.delete(runId);
        externalSelfModPathsByRun.delete(runId);
        throw error;
      }
    };

    state.finishExternalSelfModWithMorph = async ({ runId, succeeded }) => {
      const controller = state.selfModHmrController;
      if (!controller) {
        throw new Error("Self-mod HMR controller is not initialized.");
      }
      if (!controller.hasRun(runId)) {
        await controller.releaseRuns([runId]).catch((error) => {
          console.warn(
            "[self-mod-external] Failed to release Vite client update pause:",
            (error as Error).message,
          );
        });
        await releaseRuntimeReloadFor([runId]);
        selfModRunRootIds.delete(runId);
        externalSelfModPathsByRun.delete(runId);
        return { ok: true };
      }

      if (!succeeded) {
        const cancelResult = await controller.cancel(runId);
        await releaseRuntimeReloadFor([runId]);
        selfModRunRootIds.delete(runId);
        externalSelfModPathsByRun.delete(runId);
        await dispatchApplyBatch(cancelResult);
        return { ok: true };
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
          await controller.releaseRuns([runId]).catch((error) => {
            console.warn(
              "[self-mod-external] Failed to release Vite client update pause:",
              (error as Error).message,
            );
          });
          await releaseRuntimeReloadFor([runId]);
          selfModRunRootIds.delete(runId);
        }
        return { ok: true };
      }

      await dispatchApplyBatch(decision);
      return { ok: true };
    };

    const runnerOptions: StellaHostRunnerOptions = {
      deviceId: deviceIdentity.deviceId,
      stellaRoot: init.stellaRoot,
      stellaHome: init.stellaHomePath,
      runtimeStore,
      getAppBrowserContext: async () =>
        (await peer.request(
          METHOD_NAMES.HOST_APP_BROWSER_CONTEXT_GET,
          undefined,
          {
            retryOnDisconnect: true,
          },
        )) as HostAppBrowserContextSnapshot,
      listLocalChatEvents: (conversationId, maxItems) =>
        chatStore.listEvents(conversationId, maxItems),
      appendLocalChatEvent: (args) => {
        const event = chatStore.appendEvent(args);
        notifyLocalChatUpdated(peer, args.conversationId, event);
      },
      getDefaultConversationId: () =>
        chatStore.getOrCreateDefaultConversationId(),
      requestCredential: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, payload, {
          retryOnDisconnect: true,
        }),
      requestRuntimeAuthRefresh: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH, payload, {
          retryOnDisconnect: true,
        }),
      scheduleApi: {
        listCronJobs: async () =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS,
            undefined,
            { retryOnDisconnect: true },
          ),
        addCronJob: async (input) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB,
            input,
            { retryOnDisconnect: true },
          ),
        updateCronJob: async (jobId, patch) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB,
            {
              jobId,
              patch,
            },
            { retryOnDisconnect: true },
          ),
        removeCronJob: async (jobId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB,
            {
              jobId,
            },
            { retryOnDisconnect: true },
          ),
        runCronJob: async (jobId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB,
            {
              jobId,
            },
            { retryOnDisconnect: true },
          ),
        getHeartbeatConfig: async (conversationId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG,
            {
              conversationId,
            },
            { retryOnDisconnect: true },
          ),
        upsertHeartbeat: async (input) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT,
            input,
            { retryOnDisconnect: true },
          ),
        runHeartbeat: async (conversationId) =>
          await peer.request(
            METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT,
            {
              conversationId,
            },
            { retryOnDisconnect: true },
          ),
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
          commitMessageProvider,
          featureNamerProvider,
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
            ...(threadKey ? { threadKey } : {}),
            ...(commitMessageProvider ? { commitMessageProvider } : {}),
            ...(featureNamerProvider ? { featureNamerProvider } : {}),
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
      stellaComputerCliPath: resolveRuntimeCliPath("stella-computer.js"),
      stellaConnectCliPath: resolveRuntimeCliPath("stella-connect.js"),
      // Only advertise the bridge socket once it's listening. If startup
      // failed (state.cliBridgeServer === null) the CLI gracefully falls
      // back to exit-2 `auth_required` instead of dialing a dead socket.
      cliBridgeSocketPath: state.cliBridgeServer?.socketPath,
      notifyVoiceActionComplete: (payload) => {
        emitVoiceActionCompleted(payload);
      },
    };

    // Install the morph-cover revert handler. Lives here (inside
    // initializeWorker) so it captures `dispatchApplyBatch`,
    // `releaseRuntimeReloadFor`, `selfModRunRootIds`, and
    // `selfModHmrController` from the surrounding closure; the
    // module-level `INTERNAL_WORKER_SELF_MOD_REVERT` handler calls it
    // via `state.revertSelfModWithMorph`.
    state.revertSelfModWithMorph = async (payload) => {
      const repoRoot = init.stellaRoot;
      const syntheticRunId = `self-mod-revert:${crypto.randomUUID()}`;
      let runRegisteredWithHmr = false;
      let runtimeReloadPaused = false;

      // Resolve the target commit hash ONCE up front. Both
      // `listFilesForCommit` (snapshot) and `revertGitFeature` (the
      // actual revert) fall back to `getLastGitFeatureId` when no
      // featureId is supplied; resolving here pins both calls to the
      // same commit in the common case where there IS a last feature
      // id. Edge case: if `getLastGitFeatureId` returns null (fresh
      // repo / no Stella commits yet), `resolvedFeatureId` collapses
      // back to `undefined` and the two callsites resolve independently
      // — `revertGitFeature` will then throw cleanly with "No commit
      // found to revert" so we don't risk corruption, but the race
      // protection only applies once at least one feature commit exists.
      const resolvedFeatureId =
        payload.featureId?.trim() ||
        (await getLastGitFeatureId(repoRoot).catch(() => null)) ||
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
        await selfModHmrController.beginRun(syntheticRunId);
        runRegisteredWithHmr = true;

        // Snapshot pre-revert disk content for every file the revert
        // will touch. Vite serves the snapshot until apply, then
        // cross-fades into the reverted (live disk) content under the
        // morph cover.
        //
        // Note: when `steps > 1`, we only snapshot files from the
        // first reverted commit. Files touched by commits 2..N will
        // change on disk without a morph cover (Vite's own watcher
        // picks them up via the no-snapshot path). The current
        // callsite always passes `steps: 1` so this is dormant; a
        // future multi-step caller would need to union files across
        // the whole reverted range.
        let preRevertFiles: string[] = [];
        try {
          preRevertFiles = await listFilesForCommit(
            repoRoot,
            resolvedFeatureId ?? null,
          );
        } catch {
          // Best-effort — without it Vite still reacts via its watcher
          // post-revert, just without a morph cover.
        }
        if (preRevertFiles.length > 0) {
          const absolutePaths = preRevertFiles.map((file) =>
            path.join(repoRoot, file),
          );
          await selfModHmrController.recordWrite(syntheticRunId, absolutePaths);
        }

        const result = await revertGitFeature({
          repoRoot,
          featureId: resolvedFeatureId,
          steps: payload.steps,
        });

        // Ledger the revert so the revert-notice hook can inject on
        // the next user turn for orchestrator + originating subagent.
        // Skipped when the commit had no `Stella-Conversation`
        // trailer — without it, we have no conversation to route to.
        if (result.conversationId && state.runtimeStore) {
          try {
            state.runtimeStore.recordSelfModRevert({
              conversationId: result.conversationId,
              originThreadKey: result.originThreadKey ?? null,
              featureId: result.featureId,
              files: result.files ?? [],
            });
          } catch (error) {
            console.warn(
              "[self-mod-revert] failed to record revert notice:",
              (error as Error).message,
            );
          }
        }

        // Finalize through the shared apply pipeline — same code path
        // an agent self-mod run takes. Handles HMR vs full reload vs
        // worker restart based on path-relevance classification of the
        // files we just snapshotted.
        const decision = selfModHmrController.finalize(syntheticRunId);
        runRegisteredWithHmr = false;
        if (decision.appliedRuns.length === 0) {
          await selfModHmrController
            .releaseRuns([syntheticRunId])
            .catch((error) => {
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
          await selfModHmrController
            .releaseRuns([syntheticRunId])
            .catch(() => undefined);
        }
        if (runtimeReloadPaused) {
          await releaseRuntimeReloadFor([syntheticRunId]).catch(
            () => undefined,
          );
        }
        selfModRunRootIds.delete(syntheticRunId);
        throw err;
      }
    };

    const runner = createStellaHostRunner(runnerOptions);
    state.runner = runner;
    runner.setConvexUrl(init.convexUrl);
    runner.setConvexSiteUrl(init.convexSiteUrl);
    runner.setAuthToken(init.authToken);
    runner.setHasConnectedAccount(init.hasConnectedAccount);
    runner.setCloudSyncEnabled(init.cloudSyncEnabled);
    runner.setModelCatalogUpdatedAt(init.modelCatalogUpdatedAt);
    runner.start();
    await runner.waitUntilInitialized();

    const socialSessionService = new SocialSessionService({
      getWorkspaceRoot: () => init.stellaWorkspacePath,
      getDeviceId: () => state.deviceId,
      getRunner: () => state.runner,
      getChatStore: () => state.chatStore,
      getStore: () => state.socialSessionStore,
      onLocalChatUpdated: () => {
        notifyLocalChatUpdated(peer);
      },
      pushDisplayPayload: (payload) => {
        // Forward the structured display payload through the existing
        // host display update bridge. The renderer normalizes it via
        // `normalizeDisplayPayload` and routes it to the workspace panel.
        void peer
          .request(
            METHOD_NAMES.HOST_DISPLAY_UPDATE,
            { payload },
            {
              retryOnDisconnect: true,
            },
          )
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
        notifyLocalChatUpdated(peer);
      },
      emitAgentEvent: (payload) => {
        emitVoiceAgentEvent(payload);
      },
      emitSelfModHmrState: (payload) => {
        emitVoiceSelfModHmrState(payload);
      },
    });

    return {
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
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
    if (patch.modelCatalogUpdatedAt !== undefined) {
      state.runner?.setModelCatalogUpdatedAt(patch.modelCatalogUpdatedAt);
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
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
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
      const {
        visibleUserPrompt,
        windowContextLabel,
        browserUrl,
        appSelectionLabel,
        promptMessages,
        windowScreenshotAttachment,
      } = buildChatPromptMessages({
        userPrompt: payload.userPrompt,
        selectedText:
          payload.selectedText ?? payload.chatContext?.selectedText ?? null,
        chatContext: payload.chatContext ?? null,
        explicitImageAttachmentCount: payload.attachments?.length ?? 0,
      });
      const userMessageTimestamp = Date.now();
      const windowPreviewImageUrl = windowScreenshotAttachment?.url;
      const userMessageId =
        payload.userMessageEventId ?? `local:${crypto.randomUUID()}`;
      let userMessageEventAppended = false;
      const appendUserMessageEvent = (timestamp = userMessageTimestamp) => {
        if (userMessageEventAppended) {
          return;
        }
        userMessageEventAppended = true;
        const userMessageEvent = ensureChatStore().appendEvent({
          conversationId: payload.conversationId,
          type: "user_message",
          eventId: userMessageId,
          deviceId: payload.deviceId,
          timestamp,
          payload: prepareStoredLocalChatPayload({
            type: "user_message",
            payload: {
              text: visibleUserPrompt,
              ...(payload.attachments?.length
                ? { attachments: payload.attachments }
                : {}),
              ...(payload.platform ? { platform: payload.platform } : {}),
              ...(payload.timezone ? { timezone: payload.timezone } : {}),
              ...(payload.locale ? { locale: payload.locale } : {}),
              ...(payload.messageMetadata ||
              windowContextLabel ||
              browserUrl ||
              appSelectionLabel ||
              windowPreviewImageUrl
                ? {
                    metadata: {
                      ...(payload.messageMetadata ?? {}),
                      ...(windowContextLabel ||
                      browserUrl ||
                      appSelectionLabel ||
                      windowPreviewImageUrl
                        ? {
                            context: {
                              ...(payload.messageMetadata?.context ?? {}),
                              ...(windowContextLabel
                                ? {
                                    windowLabel: windowContextLabel,
                                  }
                                : {}),
                              ...(browserUrl
                                ? {
                                    browserUrl,
                                  }
                                : {}),
                              ...(windowPreviewImageUrl
                                ? {
                                    windowPreviewImageUrl,
                                  }
                                : {}),
                              ...(appSelectionLabel
                                ? {
                                    appSelectionLabel,
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
            timestamp,
            timezone: payload.timezone,
          }),
        });
        notifyLocalChatUpdated(peer, payload.conversationId, userMessageEvent);
      };
      if (payload.mode !== "follow_up") {
        appendUserMessageEvent();
      }

      const createSyntheticSeq = () => {
        let seq = Date.now();
        return () => {
          seq += 1;
          return seq;
        };
      };
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
      );
      const modelImageAttachments = materializedImageAttachments.map(
        ({ attachment }) => attachment,
      );
      let activeRunId = "";
      const nextSyntheticSeq = createSyntheticSeq();
      const hiddenSystemRunIds = new Set<string>();
      let lastVisibleRunId = "";
      let lastVisibleRequestId = requestId;
      /**
       * Tracks the eventId of the most-recently-persisted orchestrator
       * assistant message for this run. The `agent_end` self-mod patch
       * targets this row so the inline "Undo changes" affordance lands
       * under the post-tool answer (or under the only assistant message
       * if the run did not preamble).
       */
      let lastAssistantMessageEventId: string | null = null;
      const mergedAttachments = [
        ...modelImageAttachments,
        ...(windowScreenshotAttachment ? [windowScreenshotAttachment] : []),
      ];
      logger.info("startChat.prompt-shape", {
        conversationId: payload.conversationId,
        visibleUserPrompt,
        windowContextLabel,
        appSelectionLabel,
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
          ...(payload.selfModMetadata
            ? { selfModMetadata: payload.selfModMetadata }
            : {}),
        },
        {
          onAssistantMessage: (ev) => {
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) !==
              AGENT_IDS.ORCHESTRATOR
            ) {
              return;
            }
            const assistantEventId = appendAssistantMessageForTurn({
              conversationId: payload.conversationId,
              text: ev.text,
              userMessageId: ev.userMessageId,
              runId: ev.runId,
              seq: ev.seq,
              timezone: payload.timezone,
              responseTarget: ev.responseTarget,
            });
            if (assistantEventId) {
              lastAssistantMessageEventId = assistantEventId;
            }
            // Boundary marker on the same wire as `STREAM` chunks so the
            // renderer can reset its in-flight streaming buffer before
            // chunks for the next assistant message in this run arrive
            // (e.g. post-tool answer after a preamble). Without this the
            // buffer keeps growing across messages and the live stream
            // row replays the preamble text under the next message's
            // content.
            //
            // Use the recorder's own seq for this event (`ev.seq`) — the
            // renderer's per-conversation seq guard drops any event whose
            // seq is `<= previousSeq`. A `Date.now()`-style synthetic seq
            // here would clobber the cursor with a huge number and silently
            // drop every subsequent small-seq STREAM chunk in the run
            // (the post-tool answer would stop streaming live). For the
            // rare hidden→visible mirror path the boundary seq has to
            // belong to the visible run's cursor; fall back to a
            // synthetic value there since the visible recorder is not
            // reachable from this closure.
            const isHiddenRun = hiddenSystemRunIds.has(ev.runId);
            const targetRunId = isHiddenRun ? lastVisibleRunId : ev.runId;
            const targetRequestId = isHiddenRun
              ? lastVisibleRequestId
              : requestId;
            const boundarySeq = isHiddenRun ? nextSyntheticSeq() : ev.seq;
            if (targetRunId) {
              emitRunEvent({
                type: AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE,
                runId: targetRunId,
                seq: boundarySeq,
                conversationId: payload.conversationId,
                ...(targetRequestId ? { requestId: targetRequestId } : {}),
                userMessageId: ev.userMessageId,
                agentType: ev.agentType,
                ...(assistantEventId
                  ? { assistantMessageEventId: assistantEventId }
                  : {}),
                ...(ev.responseTarget
                  ? { responseTarget: ev.responseTarget }
                  : {}),
              });
            }
          },
          onRunStarted: (ev) => {
            activeRunId = ev.runId;
            if (ev.userMessageId === userMessageId) {
              appendUserMessageEvent(Date.now());
            }
            const isHiddenRun = ev.uiVisibility === "hidden";
            if (isHiddenRun) {
              hiddenSystemRunIds.add(ev.runId);
              if (lastVisibleRunId && ev.responseTarget) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
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
            const event = ensureChatStore().appendEvent({
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
            notifyLocalChatUpdated(peer, payload.conversationId, event);
          },
          onStream: (ev) => {
            if (hiddenSystemRunIds.has(ev.runId)) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
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
                  seq: nextSyntheticSeq(),
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
            const event = ensureChatStore().appendEvent({
              conversationId: payload.conversationId,
              type: "tool_request",
              requestId: ev.toolCallId,
              payload: {
                toolName: ev.toolName,
                ...(ev.args ? { args: ev.args } : {}),
                ...(ev.agentType ? { agentType: ev.agentType } : {}),
              },
            });
            notifyLocalChatUpdated(peer, payload.conversationId, event);
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
            const event = ensureChatStore().appendEvent({
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
            notifyLocalChatUpdated(peer, payload.conversationId, event);
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
                  seq: nextSyntheticSeq(),
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
              seq: nextSyntheticSeq(),
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
              seq: nextSyntheticSeq(),
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
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
              AGENT_IDS.ORCHESTRATOR
            ) {
              // Each assistant message in the run was already persisted
              // by `onAssistantMessage` as its own row, so end-of-run no
              // longer writes a new row from `finalText` (doing so would
              // append a duplicate of the last message).
              //
              // When the agent produced a self-mod commit AND at least
              // one chat reply, patch `selfModApplied` onto the LAST
              // persisted assistant row so the inline "Undo changes"
              // affordance sits under the post-tool answer.
              // When the agent commits but says nothing,
              // `lastAssistantMessageEventId` is null and we drop the
              // inline button for that turn — accepted trade-off
              // against the alternative of a floating-button-only
              // empty bubble.
              if (ev.selfModApplied && lastAssistantMessageEventId) {
                attachSelfModToAssistantMessage({
                  conversationId: payload.conversationId,
                  eventId: lastAssistantMessageEventId,
                  selfModApplied: ev.selfModApplied,
                });
              }
            }
            if (isHiddenRun) {
              if (lastVisibleRunId) {
                emitRunEvent({
                  ...ev,
                  runId: lastVisibleRunId,
                  seq: nextSyntheticSeq(),
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
      const event = ensureChatStore().appendEvent({
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
      notifyLocalChatUpdated(peer, conversationId, event);
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
    METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION,
    async (params) => {
      const cancelled = ensureRunner().cancelLocalChatByConversation(
        (params as { conversationId: string }).conversationId,
      );
      return { ok: true, cancelled };
    },
  );

  // Worker-side replay: read everything past `lastSeq` for `runId` from
  // the persistent ring buffer. This is the path Electron takes after a
  // restart — by the time the host reconnects, the in-memory host buffer
  // is gone but the worker still has every event.
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS,
    async (params) => {
      const payload = params as { runId?: unknown; lastSeq?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const lastSeq = Number.isFinite(Number(payload?.lastSeq))
        ? Number(payload.lastSeq)
        : 0;
      const log = state.runEventLog;
      if (!log) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const result = log.resumeAfter({ runId, lastSeq });
      const events = result.events.map(
        (record) => record.payload as unknown as AgentEventPayload,
      );
      return { events, exhausted: result.exhausted };
    },
  );

  // Host ack — every event the host successfully forwards to the renderer
  // gets acked back so the worker can prune. Best-effort: under-acking
  // just retains rows longer; over-acking before the renderer actually
  // saw an event would lose it on reconnect, so the host should only
  // ack after `webContents.send` resolves.
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_ACK_EVENTS,
    async (params) => {
      const payload = params as { runId?: unknown; lastSeq?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      const lastSeq = Number.isFinite(Number(payload?.lastSeq))
        ? Number(payload.lastSeq)
        : Number.NaN;
      if (!runId || !Number.isFinite(lastSeq)) {
        return { pruned: 0 };
      }
      const pruned = state.runEventLog?.ack({ runId, lastSeq }) ?? 0;
      return { pruned };
    },
  );

  // Probe used by a reconnecting host to discover which runs are still
  // worth subscribing to — combines the live runner's active run with
  // retained event-log rows (a run that just completed but whose terminal
  // event hasn't been acked is still resumable).
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS,
    async () => {
      const runner = state.runner;
      const activeRun = runner?.getActiveOrchestratorRun() ?? null;
      const result: Array<{
        runId: string;
        conversationId: string;
        kind: "active" | "buffered";
      }> = [];
      if (activeRun) {
        result.push({
          runId: activeRun.runId,
          conversationId: activeRun.conversationId,
          kind: "active",
        });
      }
      const activeRunId = activeRun?.runId ?? null;
      for (const buffered of state.runEventLog?.listBufferedRuns() ?? []) {
        if (buffered.runId === activeRunId) continue;
        result.push({
          runId: buffered.runId,
          conversationId: buffered.conversationId,
          kind: "buffered",
        });
      }
      return { runs: result };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
    async (params) => {
      const payload = params as {
        conversationId: string;
        userPrompt: string;
        agentType?: string;
        modelOverride?: string;
        toolWorkspaceRoot?: string;
        attachments?: RuntimeAttachmentRef[];
        connectorDeliveryTarget?: {
          requestId: string;
          conversationId: string;
        };
      };
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
      );
      return await ensureRunner().runAutomationTurn({
        ...payload,
        ...(materializedImageAttachments.length > 0
          ? {
              attachments: materializedImageAttachments.map(
                ({ attachment }) => attachment,
              ),
            }
          : {}),
      });
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
      };
      return await ensureRunner().webSearch(payload.query, {
        category: payload.category,
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

  const buildSourceBackedReleaseSummary = (args: {
    packageId: string;
    displayName?: string;
    description?: string;
    category?: StorePublishArgs["manifest"]["category"];
    releaseNotes?: string;
    attachedFeatureNames: string[];
  }): string => {
    const oneLine = (value: string | undefined): string =>
      asTrimmedString(value).replace(/\s+/g, " ");
    const title = oneLine(args.displayName) || args.packageId;
    const description = oneLine(args.description);
    const category = args.category ?? "other";
    const releaseNotes = asTrimmedString(args.releaseNotes);
    const lines = [
      `# ${title}`,
      description
        ? `> ${description}`
        : "> Source-backed Stella Store release.",
      "",
      `Category: ${category}`,
      "",
      "This release is backed by selected Stella source changes. The source pack and reference diffs are the authoritative install material.",
      "",
      "## Selected changes",
      ...args.attachedFeatureNames.map((name) => `- ${name}`),
    ];
    if (releaseNotes) {
      lines.push("", "## Release notes", releaseNotes);
    }
    return lines.join("\n");
  };

  const publishSourceBackedStoreRelease = async (
    payload: StorePublishSelectedFeaturesArgs,
  ): Promise<StorePackageReleaseRecord> => {
    if (!state.init) {
      throw new Error("Worker has not been initialized.");
    }
    const attachedFeatureNames = normalizeStoreThreadFeatureNames(
      payload.attachedFeatureNames,
    );
    if (attachedFeatureNames.length === 0) {
      throw new Error("Select at least one source-backed change to publish.");
    }

    const store = ensureStoreModStore();
    const repoRoot = state.init.stellaRoot;
    const snapshot = store.readFeatureSnapshot();
    const commits = await collectStoreReleaseCommits({
      repoRoot,
      attachedFeatureNames,
      snapshot,
    });
    if (commits.length === 0) {
      throw new Error(
        "The selected changes no longer resolve to source commits. Refresh Store and select the source changes again.",
      );
    }

    const sourcePack = await collectStoreReleaseSourcePack({
      repoRoot,
      attachedFeatureNames,
      snapshot,
      sourceHistory: ensureSourceHistoryStore(),
    });
    if (
      !sourcePack ||
      !sourcePack.changeSets.some((changeSet) => changeSet.changes.length > 0)
    ) {
      throw new Error(
        "Could not build a source pack for the selected changes. Store publishing now requires source-backed changes; try publishing a smaller, committed feature.",
      );
    }

    const baseManifest = payload.manifest ?? {};
    const category = payload.category ?? baseManifest.category;
    const redact = buildStoreReleaseRedactor();
    const blueprintMarkdown = redact(
      buildSourceBackedReleaseSummary({
        packageId: payload.packageId,
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        ...(category ? { category } : {}),
        ...(payload.releaseNotes ? { releaseNotes: payload.releaseNotes } : {}),
        attachedFeatureNames,
      }),
    );

    // The store-operations runner does not forward releaseNumber to Convex
    // (the action assigns it). We carry a sentinel here just to satisfy the
    // StorePublishArgs shape.
    const releaseNumber = 0;
    const artifact: StorePublishArgs["artifact"] = {
      kind: "blueprint",
      schemaVersion: 2,
      manifest: { ...baseManifest },
      blueprintMarkdown,
      sourcePack,
      commits,
    };
    const publishArgs: StorePublishArgs = {
      packageId: payload.packageId,
      releaseNumber,
      displayName: payload.displayName ?? "",
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.releaseNotes ? { releaseNotes: payload.releaseNotes } : {}),
      manifest: { ...baseManifest },
      artifact,
    };

    const runner = ensureRunner();
    return payload.asUpdate
      ? await runner.createStoreReleaseUpdate(publishArgs)
      : await runner.createFirstStoreRelease(publishArgs);
  };

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_BLUEPRINT,
    async (params) => {
      const payload = params as {
        messageId: string;
        packageId: string;
        asUpdate: boolean;
        displayName?: string;
        description?: string;
        category?:
          | "apps-games"
          | "productivity"
          | "customization"
          | "skills-agents"
          | "integrations"
          | "other";
        manifest: StorePublishArgs["manifest"];
        releaseNotes?: string;
      };
      if (!payload.messageId) {
        throw new Error("messageId is required.");
      }
      const store = ensureStoreModStore();
      const message = store
        .listStoreThreadMessages()
        .find((entry) => entry._id === payload.messageId);
      if (!message) {
        throw new Error("Could not find the blueprint draft to publish.");
      }
      if (!message.isBlueprint) {
        throw new Error("That message is not a publishable blueprint.");
      }
      if (message.denied) {
        throw new Error(
          "The latest blueprint draft was denied. Edit it before publishing.",
        );
      }
      return await publishSourceBackedStoreRelease({
        attachedFeatureNames: message.attachedFeatureNames ?? [],
        packageId: payload.packageId,
        asUpdate: payload.asUpdate,
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.category ? { category: payload.category } : {}),
        manifest: payload.manifest,
        ...(payload.releaseNotes ? { releaseNotes: payload.releaseNotes } : {}),
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_SELECTED_FEATURES,
    async (params) =>
      await publishSourceBackedStoreRelease(
        params as StorePublishSelectedFeaturesArgs,
      ),
  );

  // Snapshot read for the side panel features list. The snapshot is
  // regenerated by the namer LLM after every successful self-mod commit.
  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_FEATURE_SNAPSHOT_READ,
    async () => {
      const service = ensureStoreModService();
      return service.readFeatureSnapshot();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_GET,
    async () => reconcileStoreThreadPendingMessages().readStoreThread(),
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_SEND_MESSAGE,
    async (params) => {
      const store = reconcileStoreThreadPendingMessages();
      const runner = ensureRunner();
      const payload = params as StoreThreadSendInput;
      const text = normalizeStoreThreadText(payload.text);
      const attachedFeatureNames = normalizeStoreThreadFeatureNames(
        payload.attachedFeatureNames,
      );
      const pending = store
        .listStoreThreadMessages()
        .some((message) => message.pending === true);
      if (pending) {
        throw new Error(
          "The Store agent is still working. Stop it or wait for it to finish before sending another message.",
        );
      }

      const latestBlueprint = store.findLatestPublishableBlueprint();
      const userMessage = store.appendStoreThreadMessage({
        role: "user",
        text,
        attachedFeatureNames,
        editingBlueprint: payload.editingBlueprint === true,
      });
      const assistantMessage = store.appendStoreThreadMessage({
        role: "assistant",
        text: "Working…",
        pending: true,
      });
      const repoRoot = state.init?.stellaRoot;
      if (!repoRoot) {
        store.deleteStoreThreadMessages([
          userMessage._id,
          assistantMessage._id,
        ]);
        throw new Error("Worker has not been initialized.");
      }
      let prompt: string;
      try {
        prompt = buildStoreThreadAgentPrompt({
          userText: text,
          editingBlueprint: payload.editingBlueprint === true,
          ...(latestBlueprint
            ? { latestBlueprintMarkdown: latestBlueprint.text }
            : {}),
          attachedFeatureNames,
          transcript: store.listStoreThreadMessages(),
        });
      } catch (error) {
        store.deleteStoreThreadMessages([
          userMessage._id,
          assistantMessage._id,
        ]);
        throw error;
      }

      let threadId: string;
      try {
        const created = await runner.createBackgroundAgent({
          conversationId: STORE_THREAD_CONVERSATION_ID,
          // Fresh runtime thread id per send — each Store turn is one-shot.
          // The curated prompt above already re-injects the local transcript
          // and latest blueprint, so carrying runtime thread history across
          // turns would duplicate (and compound) that context.
          threadId: `store-agent-local-thread:${crypto.randomUUID()}`,
          description: "Draft Store blueprint",
          prompt,
          agentType: AGENT_IDS.STORE,
          toolWorkspaceRoot: repoRoot,
        });
        threadId = created.threadId;
      } catch (error) {
        store.deleteStoreThreadMessages([
          userMessage._id,
          assistantMessage._id,
        ]);
        throw error;
      }
      state.activeStoreThreadAgentId = threadId;
      state.activeStoreThreadMessageId = assistantMessage._id;

      void (async () => {
        while (true) {
          const agent = await runner.getLocalAgentSnapshot(threadId);
          if (!agent) {
            if (state.activeStoreThreadMessageId === assistantMessage._id) {
              store.patchStoreThreadMessage(assistantMessage._id, {
                text: "The Store agent stopped unexpectedly.",
                pending: false,
              });
              state.activeStoreThreadAgentId = null;
              state.activeStoreThreadMessageId = null;
            }
            return;
          }
          if (agent.status === "completed") {
            if (state.activeStoreThreadMessageId !== assistantMessage._id) {
              return;
            }
            const parsed = extractBlueprintMarkdown(agent.result ?? "");
            const assistantText =
              parsed.blueprintMarkdown ??
              (parsed.visibleText ||
                "I could not draft a blueprint from that request.");
            store.patchStoreThreadMessage(assistantMessage._id, {
              text: assistantText,
              pending: false,
              isBlueprint: Boolean(parsed.blueprintMarkdown),
            });
            state.activeStoreThreadAgentId = null;
            state.activeStoreThreadMessageId = null;
            return;
          }
          if (agent.status === "error" || agent.status === "canceled") {
            if (state.activeStoreThreadMessageId === assistantMessage._id) {
              store.patchStoreThreadMessage(assistantMessage._id, {
                text:
                  agent.status === "canceled"
                    ? "Stopped."
                    : (agent.error ?? "The Store agent failed."),
                pending: false,
              });
              state.activeStoreThreadAgentId = null;
              state.activeStoreThreadMessageId = null;
            }
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      })().catch((error) => {
        if (state.activeStoreThreadMessageId === assistantMessage._id) {
          store.patchStoreThreadMessage(assistantMessage._id, {
            text: (error as Error)?.message ?? "The Store agent failed.",
            pending: false,
          });
          state.activeStoreThreadAgentId = null;
          state.activeStoreThreadMessageId = null;
        }
      });
      return store.readStoreThread();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_CANCEL,
    async () => {
      const store = ensureStoreModStore();
      const agentId = state.activeStoreThreadAgentId;
      const messageId = state.activeStoreThreadMessageId;
      state.activeStoreThreadAgentId = null;
      state.activeStoreThreadMessageId = null;
      if (messageId) {
        store.patchStoreThreadMessage(messageId, {
          text: "Stopped.",
          pending: false,
        });
      } else {
        store.clearPendingStoreThreadMessages("Stopped.");
      }
      if (agentId) {
        await ensureRunner().cancelLocalAgent(agentId, "Stopped by user");
      }
      return store.readStoreThread();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_DENY_LATEST_BLUEPRINT,
    async () => {
      const store = ensureStoreModStore();
      store.denyLatestPublishableBlueprint();
      return store.readStoreThread();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_MARK_BLUEPRINT_PUBLISHED,
    async (params) => {
      const payload = params as { messageId: string; releaseNumber: number };
      const releaseNumber = Number.isFinite(payload.releaseNumber)
        ? Math.floor(payload.releaseNumber)
        : null;
      if (!payload.messageId || !releaseNumber || releaseNumber < 1) {
        throw new Error("messageId and releaseNumber are required.");
      }
      const store = ensureStoreModStore();
      store.markLatestPublishableBlueprintPublished({
        messageId: payload.messageId,
        releaseNumber,
      });
      return store.readStoreThread();
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_UNINSTALL_STORE_MOD,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { packageId: string };
      const runner = ensureRunner();
      const service = ensureStoreModService();
      const result = await service.uninstall(payload.packageId);
      if (result.fallbackRequired) {
        const install = service.getInstall(payload.packageId);
        const prompt = [
          `# Remove Stella Store add-on: ${payload.packageId}`,
          "",
          "The user wants this Store add-on removed from their Stella install.",
          "",
          "A direct git revert is not safe right now because the install commits are no longer the latest clean HEAD stack. Instead, inspect the current codebase and remove only the behavior, files, UI, prompts, settings, and wiring that belong to this add-on.",
          "",
          "Do not remove unrelated user changes or other Store add-ons. If a file contains both this add-on and unrelated edits, preserve the unrelated edits. If you cannot confidently identify the add-on's changes, stop and explain what blocks removal.",
          "",
          "When you finish, the runtime will commit the removal changes. There is nothing extra to do.",
          "",
          "## Add-on metadata",
          `Package ID: ${payload.packageId}`,
          install?.releaseNumber
            ? `Installed release: ${install.releaseNumber}`
            : "Installed release: unknown",
          install?.installCommitHashes.length
            ? `Recorded install commits: ${install.installCommitHashes.join(", ")}`
            : install?.installCommitHash
              ? `Recorded install commit: ${install.installCommitHash}`
              : "Recorded install commits: none",
          result.reason ? `Direct revert skipped: ${result.reason}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const beforeRemovalHead = await getGitHead(state.init.stellaRoot).catch(
          () => null,
        );
        const blockingResult = await runner.runBlockingLocalAgent({
          conversationId: `store-uninstall:${payload.packageId}`,
          description: `Remove ${payload.packageId} store add-on`,
          prompt,
          agentType: "general",
          selfModMetadata: {
            packageId: payload.packageId,
            ...(install?.releaseNumber
              ? { releaseNumber: install.releaseNumber }
              : {}),
            mode: "uninstall",
          },
        });
        if (blockingResult.status !== "ok") {
          throw new Error(blockingResult.error);
        }
        const afterRemovalHead = await getGitHead(state.init.stellaRoot).catch(
          () => null,
        );
        if (!afterRemovalHead || afterRemovalHead === beforeRemovalHead) {
          throw new Error(
            "Store uninstall did not apply any changes, so the add-on remains installed.",
          );
        }
        service.forgetInstall(payload.packageId);
        return {
          packageId: payload.packageId,
          revertedCommits: [],
        };
      }
      return {
        packageId: payload.packageId,
        revertedCommits: result.revertedCommits,
      };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_INSTALL_FROM_BLUEPRINT,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const init = state.init;
      const payload = params as {
        packageId: string;
        releaseNumber: number;
        displayName: string;
        blueprintMarkdown: string;
        sourcePack?: StoreReleaseSourcePack;
        commits?: StoreReleaseCommit[];
      };
      const runner = ensureRunner();
      const service = ensureStoreModService();

      const headBeforeRun = await getGitHead(init.stellaRoot).catch(() => null);
      const existingInstall = service.getInstall(payload.packageId);
      const installApplyMode = existingInstall ? "update" : "install";
      const verifiedSourcePack = payload.sourcePack
        ? assertStoreSourcePackIntegrity(payload.sourcePack)
        : undefined;
      const sourcePackPlan = payload.sourcePack
        ? selectStoreSourcePackForInstalledRevisions(
            verifiedSourcePack!,
            existingInstall?.sourceRevisionIds ?? [],
          )
        : null;
      const alreadyInstalledRevisionId =
        sourcePackPlan?.status === "already-installed"
          ? sourcePackPlan.revisionId
          : null;
      const sourcePackForAgent =
        sourcePackPlan?.status === "handoff" ? sourcePackPlan.sourcePack : null;

      // Materialise the spec + reference diffs into a per-install
      // working directory under `~/.stella/raw/`. The general agent reads
      // these files directly during the install run; the directory is
      // mutable user data and is wiped on next install of the same
      // package so retries always start clean.
      const safePackageSegment = payload.packageId.replace(
        /[^a-z0-9_-]/gi,
        "_",
      );
      const installRoot = path.join(
        state.init.stellaHomePath,
        "raw",
        "store-installs",
        `${safePackageSegment}-r${payload.releaseNumber}`,
      );
      await fsPromises
        .rm(installRoot, { recursive: true, force: true })
        .catch(() => undefined);
      await fsPromises.mkdir(installRoot, { recursive: true });
      const specPath = path.join(installRoot, "SPEC.md");
      await fsPromises.writeFile(specPath, payload.blueprintMarkdown, "utf8");

      const commits = payload.commits ?? [];
      const referencePaths: string[] = [];
      for (let index = 0; index < commits.length; index += 1) {
        const commit = commits[index];
        const ordinal = String(index + 1).padStart(2, "0");
        const safeHash = commit.hash.replace(/[^a-f0-9]/gi, "").slice(0, 12);
        const fileName = `commit-${ordinal}-${safeHash || "noid"}.diff`;
        const filePath = path.join(installRoot, fileName);
        const header = [
          `# Commit: ${commit.hash}`,
          `# Subject: ${commit.subject}`,
          "",
        ].join("\n");
        await fsPromises.writeFile(filePath, `${header}${commit.diff}`, "utf8");
        referencePaths.push(filePath);
      }

      const sourcePackPath = sourcePackForAgent
        ? path.join(installRoot, "SOURCE_PACK.json")
        : null;
      if (sourcePackForAgent && sourcePackPath) {
        await fsPromises.writeFile(
          sourcePackPath,
          `${JSON.stringify(sourcePackForAgent, null, 2)}\n`,
          "utf8",
        );
      }

      if (alreadyInstalledRevisionId) {
        return service.recordInstall({
          packageId: payload.packageId,
          releaseNumber: payload.releaseNumber,
          installCommitHash: null,
          sourceRevisionId: alreadyInstalledRevisionId,
        });
      }

      const reviewResult = await runOneShotCompletion({
        request: {
          agentType: "store_install_review",
          fallbackAgentTypes: ["general"],
          systemPrompt:
            "You are a no-tool safety reviewer for Stella Store installs. Return only the requested JSON decision.",
          userText: buildStoreInstallReviewPrompt({
            displayName: payload.displayName,
            packageId: payload.packageId,
            releaseSummary: payload.blueprintMarkdown,
            sourcePack: sourcePackForAgent,
            commits,
          }),
          temperature: 0,
          maxOutputTokens: 700,
        },
        runtime: {
          stellaRoot: init.stellaRoot,
          stellaHome: init.stellaHomePath,
          siteBaseUrl: init.convexSiteUrl,
          getAuthToken: () => init.authToken,
          hasConnectedAccount: () => state.init?.hasConnectedAccount ?? false,
          requestRuntimeAuthRefresh: async () => {
            try {
              return (await peer.request(
                METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
                { source: "store_install_review" },
                { retryOnDisconnect: true },
              )) as {
                authenticated: boolean;
                token: string | null;
                hasConnectedAccount: boolean;
              };
            } catch {
              return null;
            }
          },
        },
      });
      const reviewDecision = parseStoreInstallReviewDecision(reviewResult.text);
      if (!reviewDecision.allow) {
        throw new Error(
          `Store install review blocked this release: ${reviewDecision.reason}`,
        );
      }

      const installPrompt = buildStoreInstallPrompt({
        displayName: payload.displayName,
        packageId: payload.packageId,
        installRootPath: installRoot,
        specPath,
        sourcePackPath,
        referencePaths,
        blueprintMarkdown: payload.blueprintMarkdown,
      });

      const blockingResult = await runner.runBlockingLocalAgent({
        conversationId: `store-install:${payload.packageId}`,
        description: `Install ${payload.displayName} from store`,
        prompt: installPrompt,
        agentType: "general",
        selfModMetadata: {
          packageId: payload.packageId,
          releaseNumber: payload.releaseNumber,
          mode: installApplyMode,
        },
      });
      if (blockingResult.status !== "ok") {
        throw new Error(blockingResult.error);
      }

      // Capture HEAD after the run so we can record the install commit.
      // A successful install must produce a self-mod commit; otherwise
      // the UI would show the add-on as installed with nothing to undo.
      const headAfterRun = await getGitHead(state.init.stellaRoot).catch(
        () => null,
      );
      const installCommitHash =
        headAfterRun && headAfterRun !== headBeforeRun ? headAfterRun : null;
      if (!installCommitHash) {
        throw new Error(
          "Store install did not apply any changes, so it was not recorded as installed.",
        );
      }

      const installRecord = service.recordInstall({
        packageId: payload.packageId,
        releaseNumber: payload.releaseNumber,
        installCommitHash,
        sourceRevisionId:
          ensureSourceHistoryStore().findRevisionByCommit(installCommitHash)
            ?.revisionId ?? null,
        ...(sourcePackForAgent
          ? { sourceRevisionIds: [sourcePackForAgent.revisionId] }
          : {}),
      });
      return installRecord;
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_EXTERNAL_BEGIN,
    async (params) => {
      const handler = state.beginExternalSelfModWithMorph;
      if (!handler) {
        throw new Error("External self-mod lifecycle is not initialized.");
      }
      const payload = params as { runId?: unknown; paths?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        throw new Error("External self-mod begin requires a runId.");
      }
      const paths = Array.isArray(payload?.paths)
        ? payload.paths.filter(
            (filePath): filePath is string =>
              typeof filePath === "string" && filePath.length > 0,
          )
        : [];
      return await handler({ runId, paths });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_EXTERNAL_FINISH,
    async (params) => {
      const handler = state.finishExternalSelfModWithMorph;
      if (!handler) {
        throw new Error("External self-mod lifecycle is not initialized.");
      }
      const payload = params as { runId?: unknown; succeeded?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        throw new Error("External self-mod finish requires a runId.");
      }
      return await handler({
        runId,
        succeeded: payload?.succeeded === true,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOURCE_PACK_HISTORY_RECORD,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as {
        sourcePack?: StellaSourcePack;
        origin?: StellaSourceRevisionOrigin;
        packageId?: string;
        releaseNumber?: number;
        featureId?: string;
        description?: string;
        commitHash?: string | null;
      };
      if (
        !payload.sourcePack ||
        payload.sourcePack.kind !== "stella-source-pack" ||
        payload.sourcePack.schemaVersion !== 1
      ) {
        throw new Error("A Stella source pack is required.");
      }
      const origin = payload.origin ?? "official";
      recordSourcePackHistory({
        sourcePack: payload.sourcePack,
        origin,
        ...(payload.packageId ? { packageId: payload.packageId } : {}),
        ...(typeof payload.releaseNumber === "number"
          ? { releaseNumber: payload.releaseNumber }
          : {}),
        ...(payload.featureId ? { featureId: payload.featureId } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.commitHash ? { commitHash: payload.commitHash } : {}),
      });
      return { ok: true };
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
        await releaseRuntimeReloadFor(staleRunIds);
        return { ok: false, reason: "unknown-transition" as const };
      }
      const controller = state.selfModHmrController;
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
        await releaseRuntimeReloadFor(
          pending.applyResult.restartRelevantRunIds,
          { allowDeferredReload: false },
        );
        for (const runId of pending.applyResult.restartRelevantRunIds) {
          selfModRunRootIds.delete(runId);
        }
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
        await releaseRuntimeReloadFor(
          pending.applyResult.restartRelevantRunIds,
          { allowDeferredReload: pending.requiresRuntimeRestart },
        );
        for (const runId of pending.applyResult.restartRelevantRunIds) {
          selfModRunRootIds.delete(runId);
        }
        return { ok: false, reason: "apply-failed" as const };
      }
      pendingApplyBatches.delete(transitionId);
      await releaseRuntimeReloadFor(pending.applyResult.restartRelevantRunIds, {
        allowDeferredReload: pending.requiresRuntimeRestart,
      });
      for (const runId of pending.applyResult.restartRelevantRunIds) {
        selfModRunRootIds.delete(runId);
      }
      return {
        ok: true,
        requiresClientFullReload:
          applyResponse.requiresClientFullReload === true,
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
      const eventArgs = params as {
        conversationId: string;
        type: string;
        payload?: unknown;
        requestId?: string;
        targetDeviceId?: string;
        deviceId?: string;
        timestamp?: number;
        eventId?: string;
        channelEnvelope?: unknown;
      };
      const event = ensureChatStore().appendEvent(eventArgs);
      notifyLocalChatUpdated(peer, eventArgs.conversationId, event);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        maxItems?: number;
      };
      return ensureChatStore().listEvents(
        payload.conversationId ?? "",
        payload.maxItems,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT,
    async (params) => {
      const payload = params as { conversationId?: string };
      return ensureChatStore().getEventCount(payload.conversationId ?? "");
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        message?: string;
        firstReport?: unknown;
      };
      const conversationId = payload.conversationId ?? "";
      const message =
        typeof payload.message === "string" ? payload.message : "";
      let latestEvent: LocalChatEventRecord | undefined;
      if (message.trim().length > 0) {
        latestEvent = ensureChatStore().appendEvent({
          conversationId,
          type: "assistant_message",
          payload: prepareStoredLocalChatPayload({
            type: "assistant_message",
            payload: { text: message },
            timestamp: Date.now(),
          }),
        });
      }
      const firstReport =
        payload.firstReport &&
        typeof payload.firstReport === "object" &&
        !Array.isArray(payload.firstReport)
          ? (payload.firstReport as Record<string, unknown>)
          : null;
      const reportTitle =
        typeof firstReport?.title === "string" ? firstReport.title.trim() : "";
      const reportHtml =
        typeof firstReport?.html === "string" ? firstReport.html : "";
      if (reportTitle && reportHtml.trim() && state.init?.stellaHomePath) {
        const rawSlug =
          typeof firstReport?.slug === "string" ? firstReport.slug : "";
        const slug =
          rawSlug
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "report-welcome";
        const timestamp = Date.now();
        const filePath = path.join(
          state.init.stellaHomePath,
          "outputs",
          "html",
          `${slug}.html`,
        );
        let kind: "add" | "update" = "add";
        try {
          await fsPromises.access(filePath);
          kind = "update";
        } catch {
          kind = "add";
        }
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, reportHtml, "utf8");
        const bytes = Buffer.byteLength(reportHtml, "utf8");
        latestEvent = ensureChatStore().appendEvent({
          conversationId,
          type: "tool_result",
          requestId: `onboarding-first-report-${timestamp}`,
          timestamp: timestamp + 1,
          payload: {
            toolName: "html",
            result: `Canvas "${reportTitle}" saved to ${filePath} and opened in the panel.`,
            resultPreview: `Canvas "${reportTitle}" saved to ${filePath} and opened in the panel.`,
            details: {
              filePath,
              slug,
              title: reportTitle,
              createdAt: timestamp,
              bytes,
            },
            filePath,
            slug,
            title: reportTitle,
            createdAt: timestamp,
            bytes,
            fileChanges: [fileChange(filePath, { type: kind })],
            agentType: AGENT_IDS.ORCHESTRATOR,
          },
        });
      }
      notifyLocalChatUpdated(peer, conversationId, latestEvent);
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
      const data = await collectBrowserData(state.init.stellaHomePath, {
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
        state.init.stellaHomePath,
        payload.categories as
          | import("../contracts/discovery.js").DiscoveryCategory[]
          | undefined,
        payload.selectedBrowser,
        payload.selectedProfile,
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED,
    async () => {
      return ensureStoreModService().listInstalls();
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
      if (!state.revertSelfModWithMorph) {
        // Worker initialized without HMR wiring (test fixtures, e.g.).
        // Fall back to the raw revert with no morph cover or ledger
        // — better than refusing the user's undo entirely.
        const result = await revertGitFeature({
          repoRoot: state.init.stellaRoot,
          featureId: payload.featureId,
          steps: payload.steps,
        });
        return result;
      }
      return await state.revertSelfModWithMorph({
        featureId: payload.featureId,
        steps: payload.steps,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_CRASH_RECOVERY_STATUS,
    async () => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const dirtyFiles = await listGitDirtyFiles(state.init.stellaRoot);
      if (dirtyFiles.length > 0) {
        const mtimes = await Promise.all(
          dirtyFiles.map(async (file) => {
            try {
              const stat = await fsPromises.stat(
                path.join(state.init!.stellaRoot, file),
              );
              return stat.mtimeMs;
            } catch {
              return null;
            }
          }),
        );
        const latestChangedAtMs = mtimes.reduce<number | null>(
          (latest, value) =>
            typeof value === "number"
              ? Math.max(latest ?? value, value)
              : latest,
          null,
        );
        return {
          kind: "dirty",
          changedFileCount: dirtyFiles.length,
          latestChangedAtMs,
        };
      }
      const [latestFeature = null] = await listRecentGitFeatures(
        state.init.stellaRoot,
        1,
      );
      return {
        kind: "clean",
        latestFeature,
      };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_DISCARD_UNFINISHED,
    async () => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      return await discardGitDirtyFiles(state.init.stellaRoot);
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
    METHOD_NAMES.INTERNAL_WORKER_ONE_SHOT_COMPLETION,
    async (params): Promise<RuntimeOneShotCompletionResult> => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const init = state.init;
      const request = params as RuntimeOneShotCompletionRequest;
      return await runOneShotCompletion({
        request,
        runtime: {
          stellaRoot: init.stellaRoot,
          stellaHome: init.stellaHomePath,
          siteBaseUrl: init.convexSiteUrl,
          getAuthToken: () => init.authToken,
          hasConnectedAccount: () => state.init?.hasConnectedAccount ?? false,
          requestRuntimeAuthRefresh: async () => {
            try {
              return (await peer.request(
                METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
                { source: "stella_provider" },
                { retryOnDisconnect: true },
              )) as {
                authenticated: boolean;
                token: string | null;
                hasConnectedAccount: boolean;
              };
            } catch {
              return null;
            }
          },
        },
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DREAM_TRIGGER_NOW,
    async (params) => {
      const trigger =
        (params as { trigger?: "manual" | "startup_catchup" } | undefined)
          ?.trigger ?? "manual";
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

  return {
    hasActiveWork,
    shutdown: shutdownWorker,
  };
};
