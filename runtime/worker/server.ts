import crypto from "node:crypto";
import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import type { WorkerPeerLike } from "./peer-broker.js";
import { getFileLogger } from "../observability/file-logger.js";
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
  type RuntimePromptMessage,
  type RuntimeOneShotCompletionRequest,
  type RuntimeOneShotCompletionResult,
  type RuntimeVoiceToolCallPayload,
  type StorePublishArgs,
  type StorePublishSelectedFeaturesArgs,
  type RuntimeLocalAgentRequest,
} from "../protocol/index.js";
import type {
  StorePackageReleaseRecord,
  StoreReleaseCommit,
  StoreReleaseGitArtifact,
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
// Runner subgraph imported as types only — the values are loaded lazily (see
// loadOneShotCompletion / loadChatPromptContext and the dynamic import in
// buildRunner) so this ~68%-of-bundle subgraph isn't parsed on the worker-ready
// path.
import type {
  createStellaHostRunner,
  StellaHostRunnerOptions,
} from "../kernel/runner.js";
import { getDevServerUrl } from "./dev-url.js";
import {
  startCliBridgeServer,
  type CliBridgeServer,
} from "./cli-bridge-server.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import {
  detectSelfModAppliedSince,
  getGitHead,
  getLastSelfModCommitHash,
  listGitDirtyFiles,
  listRecentSelfModCommits,
} from "../kernel/self-mod/git/log.js";
import {
  discardGitDirtyFiles,
  rollbackGitChangesSince,
} from "../kernel/self-mod/git/revert.js";
import {
  createSelfModHmrController,
  type ApplyOptions,
  type SelfModHmrController,
} from "../kernel/self-mod/hmr.js";
import {
  createSelfModCoordinator,
  recordSelfModRevertNotice,
  type PendingSelfModApply,
} from "./self-mod-coordinator.js";
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
  stellaAppDir: string;
  stellaDataDirPath: string;
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

const normalizeStoreInstallRollbackPaths = (paths: string[]): string[] =>
  Array.from(
    new Set(
      paths
        .map((filePath) => filePath.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ),
  ).sort();

const storeInstallCommitSubjectPolicy = (args: {
  packageId: string;
  mode: "install" | "update";
}) => {
  const expectedPrefix =
    args.mode === "update" ? "Store update" : "Store install";
  const expected = `${expectedPrefix}: ${args.packageId}`;
  return (subject: string) => subject === expected;
};

const rollbackFailedStoreInstall = async (args: {
  repoRoot: string;
  startingHeadCommit: string | null;
  baselineDirtyFiles: Set<string>;
  packageId: string;
  mode: "install" | "update";
}): Promise<void> => {
  if (!args.startingHeadCommit) return;
  const currentDirtyFiles = await listGitDirtyFiles(args.repoRoot).catch(
    () => [],
  );
  const changedFiles = normalizeStoreInstallRollbackPaths(
    currentDirtyFiles.filter(
      (filePath) => !args.baselineDirtyFiles.has(filePath),
    ),
  );
  const result = await rollbackGitChangesSince({
    repoRoot: args.repoRoot,
    startingHeadCommit: args.startingHeadCommit,
    changedFiles,
    isOwnedCommitSubject: storeInstallCommitSubjectPolicy({
      packageId: args.packageId,
      mode: args.mode,
    }),
    allowRevertWithLocalChanges: true,
  });
  if (result.status === "skipped") {
    logger.warn("store-install.rollback.skipped", {
      packageId: args.packageId,
      mode: args.mode,
      reason: result.reason,
      headCommit: result.headCommit,
      changedFileCount: changedFiles.length,
    });
    return;
  }
  logger.info("store-install.rollback.done", {
    packageId: args.packageId,
    mode: args.mode,
    headCommit: result.headCommit,
    restoredFileCount: result.restoredFiles.length,
  });
};

const resolveDesktopCliEntrypoint = (
  stellaAppDir: string,
  packageName: string,
  entrypoint: string,
): string => {
  const desktopLocal = path.join(
    stellaAppDir,
    "desktop",
    packageName,
    "bin",
    entrypoint,
  );
  if (existsSync(desktopLocal)) {
    return desktopLocal;
  }

  return path.join(stellaAppDir, packageName, "bin", entrypoint);
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
  selfModApplied?: {
    commitHash: string;
    files: string[];
    batchIndex: number;
    status?: "pending" | "applied";
  };
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
  // Shared promise for the background runner build (lazy chunk import). Null
  // when no build is in flight; resolves to the runner once constructed.
  runnerReadyPromise: Promise<RuntimeRunner> | null;
  deviceId: string | null;
  selfModHmrController: SelfModHmrController | null;
  pendingSelfModApplies: Map<string, PendingSelfModApply>;
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
   * the worker re-inits with a new stellaAppDir, stopped on shutdown.
   * See `cli-bridge-server.ts`.
   */
  cliBridgeServer: CliBridgeServer | null;
};

type StoredSelfModApplied = {
  commitHash?: string;
  files?: string[];
  batchIndex?: number;
  status?: "pending" | "applied";
};

// Resolve a runtime CLI bundled into desktop/dist-electron/runtime/kernel/cli/.
const resolveRuntimeCliPath = (fileName: string) =>
  resolveBundledRuntimeFile(`kernel/cli/${fileName}`);

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

import {
  buildStoreReleaseRedactor,
  collectStoreReleaseCommits,
  collectStoreReleaseGitArtifact,
  normalizeStoreThreadFeatureNames,
} from "./store-thread-helpers.js";
import {
  buildStoreInstallPrompt,
  buildStoreInstallReviewPrompt,
  parseStoreInstallReviewDecision,
} from "./store-install-prompt.js";
import {
  materializeStoreGitArtifactReference,
  tryStoreGitArtifactFastPath,
} from "./store-git-artifact-install.js";
import { importExternalSource } from "./source-import-external.js";
import {
  approximateDataUrlBytes,
  buildSpilledAttachmentNotice,
  INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
  spillImageAttachmentsToDisk,
  type SpilledImageAttachment,
} from "./chat-attachment-spill.js";

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
  // `runner.stop()` now awaits a bounded drain of the background
  // compaction scheduler so SQLite writes complete before we close
  // `state.db`. Without this await, an in-flight `compactThread` could
  // race the `db.close()` below.
  // If the runner is still building in the background (lazy chunk import), wait
  // for it to finish so we don't strand a started-but-unreferenced runner after
  // nulling state.runner. The build's own supersede guard (state.db !== db) may
  // already have stopped it; awaiting here is still safe (stop is idempotent).
  const pendingRunnerReady = state.runnerReadyPromise;
  state.runnerReadyPromise = null;
  if (pendingRunnerReady) {
    await pendingRunnerReady.catch(() => undefined);
  }
  await state.runner?.stop();
  state.runner = null;
  state.chatStore = null;
  state.runtimeStore = null;
  state.storeModStore = null;
  state.sourceHistoryStore = null;
  state.storeModService = null;
  state.socialSessionStore = null;
  state.selfModHmrController = null;
  state.pendingSelfModApplies.clear();
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
    runnerReadyPromise: null,
    deviceId: null,
    selfModHmrController: null,
    pendingSelfModApplies: new Map(),
    runEventLog: null,
    cliBridgeServer: null,
  };

  // Lazy loaders for the runner subgraph. runner.ts, one-shot-completion.ts and
  // chat-prompt-context.ts share ~80 files and together are ~68% of the worker
  // bundle's eager parse, yet are only needed once a turn/review actually runs.
  // Importing them on first use (and building the runner in the post-ready
  // background slot) keeps that parse off the worker-ready path. The dynamic
  // import()s are also what let esbuild split them into their own chunk.
  let oneShotCompletionModule:
    | Promise<typeof import("../kernel/agent-runtime/one-shot-completion.js")>
    | null = null;
  const loadOneShotCompletion = () =>
    (oneShotCompletionModule ??= import(
      "../kernel/agent-runtime/one-shot-completion.js"
    ));
  let chatPromptContextModule:
    | Promise<typeof import("../kernel/chat-prompt-context.js")>
    | null = null;
  const loadChatPromptContext = () =>
    (chatPromptContextModule ??= import("../kernel/chat-prompt-context.js"));

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
    const requestPinned = (peer.activeRequestHandlerCount?.() ?? 0) > 0;
    const pendingApplyPinned = selfMod.hasPendingApplyBatches();
    return Boolean(
      state.runner?.getActiveOrchestratorRun() ||
        (state.runner?.getActiveAgentCount() ?? 0) > 0 ||
        requestPinned ||
        pendingApplyPinned ||
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
    selfModApplied: {
      commitHash: string;
      files: string[];
      batchIndex: number;
      status?: "pending" | "applied";
    };
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

  const patchSelfModApplyStatus = (args: {
    conversationId: string;
    eventId?: string;
    commitHash: string;
    status: "pending" | "applied";
  }): void => {
    const current = state.chatStore
      ?.listEvents(args.conversationId, 500)
      .find((event) => {
        if (args.eventId) {
          return event._id === args.eventId;
        }
        const payload = event.payload as
          | { selfModApplied?: StoredSelfModApplied }
          | undefined;
        return payload?.selfModApplied?.commitHash === args.commitHash;
      });
    const currentPayload = current?.payload as
      | { selfModApplied?: StoredSelfModApplied }
      | undefined;
    const currentSelfMod = currentPayload?.selfModApplied;
    if (!current || currentSelfMod?.commitHash !== args.commitHash) {
      return;
    }
    const updated = ensureChatStore().mergeEventPayload({
      conversationId: args.conversationId,
      eventId: current._id,
      patch: {
        selfModApplied: {
          ...currentSelfMod,
          status: args.status,
        },
      },
    });
    if (updated) {
      notifyLocalChatUpdated(peer, args.conversationId, updated);
    }
  };

  const selfMod = createSelfModCoordinator({
    peer,
    getController: () => state.selfModHmrController,
    getStoreModService: () => state.storeModService,
    getRuntimeStore: () => state.runtimeStore,
    getRepoRoot: () => state.init?.stellaAppDir ?? null,
    getPendingSelfModApplies: () => state.pendingSelfModApplies,
    patchSelfModApplyStatus,
  });

  const ensureRunner = () => {
    if (!state.runner) {
      throw new Error("Runtime worker is not ready.");
    }
    return state.runner;
  };

  const joinRunnerBuild = async () => {
    // The runner is built in the background after the worker reports ready, so
    // the first request can arrive before state.runner exists. Join the shared
    // build promise (swallow its error; ensureRunner() then surfaces the real
    // failure or returns the built runner).
    if (!state.runner && state.runnerReadyPromise) {
      await state.runnerReadyPromise.catch(() => undefined);
    }
  };

  const ensureRunnerInitialized = async () => {
    // Join the background build (see joinRunnerBuild), then ensureRunner()
    // returns the runner or throws if it failed or was superseded.
    await joinRunnerBuild();
    const runner = ensureRunner();
    await runner.waitUntilInitialized();
    return runner;
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
    if (
      args.commitHash &&
      sourceHistory.findRevisionByCommit(args.commitHash)
    ) {
      return;
    }
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
      state.init?.stellaAppDir === init.stellaAppDir &&
      state.init?.stellaDataDirPath === init.stellaDataDirPath &&
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
      await selfMod.releasePendingApplyBatches("worker initialization");
    }
    state.init = init;

    const db = createDesktopDatabase(init.stellaDataDirPath);
    const chatStore = new ChatStore(db);
    const runtimeStore = chatStore as RuntimeStore;
    const storeModStore = new StoreModStore(db);
    const sourceHistoryStore = new StellaSourceHistoryStore(db);
    const socialSessionStore = new SocialSessionStore(db);
    const storeModService = new StoreModService(
      init.stellaAppDir,
      storeModStore,
      sourceHistoryStore,
    );
    const runEventLog = new RunEventLog(db);
    const deviceIdentity = await peer.request<HostDeviceIdentity>(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
    );
    state.deviceId = deviceIdentity.deviceId;
    const selfModHmrController = createSelfModHmrController({
      getDevServerUrl,
      enabled: process.env.NODE_ENV === "development",
      repoRoot: init.stellaAppDir,
    });
    state.selfModHmrController = selfModHmrController;

    state.db = db;
    state.chatStore = chatStore;
    state.runtimeStore = runtimeStore;
    state.storeModStore = storeModStore;
    state.sourceHistoryStore = sourceHistoryStore;
    state.storeModService = storeModService;
    state.socialSessionStore = socialSessionStore;
    state.runEventLog = runEventLog;
    const bridgePaths = resolveRuntimePaths(init.stellaAppDir);

    const runEventLogStartupBackfill = () => {
      if (state.runEventLog !== runEventLog) return;
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
    };

    const startCliBridge = async () => {
      if (state.db !== db) return;
      try {
        const cliBridgeServer = await startCliBridgeServer({
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
            requestDesktopPermission: async ({ kind }) => {
              try {
                const result = await peer.request<{
                  granted: boolean;
                  alreadyGranted: boolean;
                }>(METHOD_NAMES.HOST_SYSTEM_REQUEST_PERMISSION, kind, {
                  retryOnDisconnect: true,
                });
                return { ok: true, ...result };
              } catch (error) {
                return {
                  ok: false,
                  reason: (error as Error).message || "host_unreachable",
                };
              }
            },
          },
        });
        if (state.db !== db) {
          await cliBridgeServer.stop().catch(() => undefined);
          return;
        }
        state.cliBridgeServer = cliBridgeServer;
      } catch (error) {
        console.warn(
          "[cli-bridge] Failed to start CLI bridge server:",
          (error as Error).message,
        );
        if (state.db === db) {
          state.cliBridgeServer = null;
        }
      }
    };

    const runnerOptions: StellaHostRunnerOptions = {
      deviceId: deviceIdentity.deviceId,
      stellaAppDir: init.stellaAppDir,
      stellaDataDir: init.stellaDataDirPath,
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
      sourceImportApi: {
        importSource: async (payload) => {
          const currentInit = state.init;
          if (!currentInit) {
            throw new Error("Worker has not been initialized.");
          }
          return await importExternalSource({
            repoRoot: currentInit.stellaAppDir,
            stellaDataDir: currentInit.stellaDataDirPath,
            source: payload.source,
            scope: payload.scope,
            trust: payload.trust,
            conversationId: payload.conversationId,
            requestId: payload.requestId,
            service: storeModService,
            lifecycle: selfMod.externalLifecycle,
            runReview: async ({ prompt }) => {
              const review = await (
                await loadOneShotCompletion()
              ).runOneShotCompletion({
                request: {
                  agentType: "source_import_review",
                  fallbackAgentTypes: ["store_install_review", "general"],
                  systemPrompt:
                    "You are a no-tool safety reviewer for source imports. Return only the requested JSON decision.",
                  userText: prompt,
                  temperature: 0,
                  maxOutputTokens: 700,
                },
                runtime: {
                  stellaAppDir: currentInit.stellaAppDir,
                  stellaDataDir: currentInit.stellaDataDirPath,
                  siteBaseUrl: currentInit.convexSiteUrl,
                  getAuthToken: () => currentInit.authToken,
                  hasConnectedAccount: () =>
                    state.init?.hasConnectedAccount ?? false,
                  requestRuntimeAuthRefresh: async () => {
                    try {
                      return (await peer.request(
                        METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
                        { source: "source_import_review" },
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
              return review.text;
            },
            runBlockingLocalAgent: async (request) =>
              await (
                await ensureRunnerInitialized()
              ).runBlockingLocalAgent(request),
            ...(payload.signal ? { signal: payload.signal } : {}),
            log: (event, fields) => logger.info(event, fields),
          });
        },
      },
      // Store agent moved to backend — no local agent surface.
      selfModMonitor: {
        getBaselineHead: getGitHead,
        detectAppliedSince: detectSelfModAppliedSince,
      },
      selfModHmrController,
      selfModLifecycle: selfMod.lifecycle,
      stellaBrowserBinPath: resolveDesktopCliEntrypoint(
        init.stellaAppDir,
        "stella-browser",
        "stella-browser.js",
      ),
      stellaOfficeBinPath: resolveDesktopCliEntrypoint(
        init.stellaAppDir,
        "stella-office",
        "stella-office.js",
      ),
      stellaComputerCliPath: resolveRuntimeCliPath("stella-computer.js"),
      stellaConnectCliPath: resolveRuntimeCliPath("stella-connect.js"),
      stellaMediaCliPath: resolveRuntimeCliPath("stella-media.js"),
      stellaXApiCliPath: resolveRuntimeCliPath("stella-x-api.js"),
      // The bridge listens in post-ready startup. Advertise the stable socket
      // path up front so shells spawned after the bridge comes online can call
      // back into the host without rebuilding the runner.
      cliBridgeSocketPath: bridgePaths.cliBridgeSocketPath,
    };

    // Build the runner in the background instead of on the worker-ready path:
    // its module subgraph is ~68% of the bundle's eager parse and is only
    // needed once a turn runs. initializeWorker returns "ready" without awaiting
    // this; turn handlers join the same promise via ensureRunnerInitialized().
    // The dynamic import() is also what lets esbuild split the runner into its
    // own chunk (see dev-electron-build.mjs).
    const buildRunner = async (): Promise<RuntimeRunner> => {
      const { createStellaHostRunner } = await import("../kernel/runner.js");
      const runner = createStellaHostRunner(runnerOptions);
      // A re-init may have superseded this generation while the chunk imported.
      // `db` is replaced only on re-init (config patches keep it), so it's the
      // safe supersede token — discard rather than clobber the new generation.
      if (state.db !== db) {
        await runner.stop().catch(() => undefined);
        return runner;
      }
      // Apply the latest config (config patches that arrived during the import
      // no-op'd against a null state.runner, so re-apply from state.init).
      const cfg = state.init ?? init;
      runner.setConvexUrl(cfg.convexUrl);
      runner.setConvexSiteUrl(cfg.convexSiteUrl);
      runner.setAuthToken(cfg.authToken);
      runner.setHasConnectedAccount(cfg.hasConnectedAccount);
      runner.setCloudSyncEnabled(cfg.cloudSyncEnabled);
      runner.setModelCatalogUpdatedAt(cfg.modelCatalogUpdatedAt);
      state.runner = runner;
      runner.start();
      return runner;
    };
    const runnerReadyPromise = buildRunner();
    state.runnerReadyPromise = runnerReadyPromise;
    // Prevent an unobserved rejection from crashing the worker; real awaiters
    // (ensureRunnerInitialized / stopWorkerServices / the post-ready block)
    // surface the error.
    runnerReadyPromise.catch(() => undefined);

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

    setTimeout(() => {
      void (async () => {
        const startupStartedAt = Date.now();
        const connectorSweep = await sweepStaleConnectorBridgeProcesses(
          init.stellaDataDirPath,
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
        // The connector sweep above must finish before anything can spawn new
        // connector helpers, so it stays a serial pre-step. The remaining
        // startup tasks are independent of one another — run them concurrently
        // instead of serially to shorten worker warm-up.
        await Promise.allSettled([
          (async () => runEventLogStartupBackfill())(),
          selfModHmrController.forceResumeAll().catch((error) => {
            console.warn(
              "[self-mod-hmr] Failed to clear stale Vite state during worker initialization:",
              (error as Error).message,
            );
            return false;
          }),
          startCliBridge(),
          (async () => {
            const builtRunner = await runnerReadyPromise.catch(() => null);
            await builtRunner?.waitUntilInitialized().catch((error) => {
              console.warn(
                "[runtime-worker] Runner initialization finished with an error:",
                (error as Error).message,
              );
            });
          })(),
        ]);
        getFileLogger()?.process("startup.post-ready-complete", {
          ms: Date.now() - startupStartedAt,
        });
      })();
    }, 0);

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
      // Warm the catalog against whatever config the worker initialized
      // with so a restart/reattach (module-level catalog cache is empty in
      // a fresh worker process) doesn't make the next chat pay the cold
      // fetch. Best-effort.
      scheduleModelCatalogWarm();
      return result;
    },
  );

  let pendingConfigPatch: Partial<WorkerInitializationState> | null = null;

  // Warm the Stella model catalog in the background whenever an input to its
  // cache key changes. The catalog cache is keyed by auth identity + device +
  // `modelCatalogUpdatedAt`. `modelCatalogUpdatedAt` is pushed down by the
  // renderer after it mounts, so the warm fired at worker init (under a
  // `null` updated-at) is followed by one under the real key once config
  // arrives — both off the open burst, since the worker itself now spawns
  // after first paint. Debounced so a `configure` call touching multiple
  // fields only warms once, and best-effort so a network failure never
  // affects config application.
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleModelCatalogWarm = () => {
    if (!state.runner) return;
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      warmTimer = null;
      const warmStartedAt = Date.now();
      void state.runner
        ?.warmModelCatalog()
        .then(() => {
          getFileLogger()?.process("startup.catalog-warmed", {
            ms: Date.now() - warmStartedAt,
          });
        })
        .catch(() => undefined);
    }, 50);
  };

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
    // Auth identity and the catalog version are the two cache-key inputs
    // the runtime controls; re-warm when either moves.
    if (
      patch.authToken !== undefined ||
      patch.modelCatalogUpdatedAt !== undefined
    ) {
      scheduleModelCatalogWarm();
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
    const activeRun =
      state.runner?.getActiveOrchestratorRun() ??
      state.runner?.listActiveAgentRuns()[0] ??
      null;
    return {
      health,
      activeRun,
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
      // Tolerate the runner still building (post-ready window): no runner ⇒ no
      // active run.
      return state.runner?.getActiveOrchestratorRun() ?? null;
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
      let modelImageAttachments = materializedImageAttachments.map(
        ({ attachment }) => attachment,
      );
      const totalInlineImageBytes = modelImageAttachments.reduce(
        (total, attachment) => total + approximateDataUrlBytes(attachment.url),
        0,
      );
      let spilledImageAttachments: SpilledImageAttachment[] = [];
      if (totalInlineImageBytes > INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES) {
        if (!state.init) {
          throw new Error("Worker has not been initialized.");
        }
        spilledImageAttachments = await spillImageAttachmentsToDisk({
          stellaDataDirPath: state.init.stellaDataDirPath,
          conversationId: payload.conversationId,
          attachments: modelImageAttachments,
        });
        modelImageAttachments = [];
      }
      const { buildChatPromptMessages } = await loadChatPromptContext();
      const {
        visibleUserPrompt,
        windowContextLabel,
        browserUrl,
        appSelectionLabel,
        activityLabel,
        promptMessages,
        windowScreenshotAttachment,
      } = buildChatPromptMessages({
        userPrompt: payload.userPrompt,
        selectedText:
          payload.selectedText ?? payload.chatContext?.selectedText ?? null,
        chatContext: payload.chatContext ?? null,
        explicitImageAttachmentCount: modelImageAttachments.length,
      });
      const runPromptMessages: RuntimePromptMessage[] = [
        ...(promptMessages ?? []),
        ...(spilledImageAttachments.length > 0
          ? [
              {
                text: buildSpilledAttachmentNotice(spilledImageAttachments),
                uiVisibility: "hidden" as const,
                messageType: "message" as const,
                customType: "runtime.chat_context",
              },
            ]
          : []),
      ];
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
              activityLabel ||
              windowPreviewImageUrl
                ? {
                    metadata: {
                      ...(payload.messageMetadata ?? {}),
                      ...(windowContextLabel ||
                      browserUrl ||
                      appSelectionLabel ||
                      activityLabel ||
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
                              ...(activityLabel
                                ? {
                                    activityLabel,
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
      let activeRunId = "";
      const nextSyntheticSeq = createSyntheticSeq();
      const hiddenSystemRunIds = new Set<string>();
      let lastVisibleRunId = "";
      let lastVisibleRequestId = requestId;
      const hasActiveAgentForRootRun = (runId: string | undefined): boolean => {
        if (!runId) return false;
        return (
          state.runner
            ?.listActiveAgentRuns()
            .some((agentRun) => agentRun.runId === runId) ?? false
        );
      };
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
        activityLabel,
        promptMessages: runPromptMessages.map((message, index) => ({
          index,
          uiVisibility: message.uiVisibility ?? "visible",
          textPreview: message.text.slice(0, 200),
        })),
        incomingAttachmentCount: payload.attachments?.length ?? 0,
        modelImageAttachmentCount: modelImageAttachments.length,
        mergedAttachmentCount: mergedAttachments.length,
        totalInlineImageBytes,
        spilledImageAttachmentCount: spilledImageAttachments.length,
        hasWindowScreenshotAttachment: Boolean(windowScreenshotAttachment),
      });
      const result = await (
        await ensureRunnerInitialized()
      ).handleLocalChat(
        {
          conversationId: payload.conversationId,
          userMessageId,
          userPrompt: visibleUserPrompt,
          ...(runPromptMessages.length
            ? { promptMessages: runPromptMessages }
            : {}),
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
                if (hasActiveAgentForRootRun(lastVisibleRunId)) {
                  return;
                }
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
            if (
              (ev.agentType ?? AGENT_IDS.ORCHESTRATOR) ===
                AGENT_IDS.ORCHESTRATOR &&
              hasActiveAgentForRootRun(ev.runId)
            ) {
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
              // Card attach is driven by the deferred-apply STASH, not by
              // `ev.selfModApplied` (detectAppliedSince): with background
              // spawn_agent the commit usually lands after the user turn ends
              // and before the follow-up turn's baseline, so neither turn's
              // baseline..HEAD window contains it and `ev.selfModApplied` is
              // unreliably false. The stash (from finalizeRun) always carries
              // the commit + files, so attach any not-yet-carded pending change
              // for this conversation onto the latest assistant reply.
              if (lastAssistantMessageEventId) {
                for (const [
                  commitHash,
                  pending,
                ] of state.pendingSelfModApplies) {
                  if (
                    pending.conversationId !== payload.conversationId ||
                    pending.assistantMessageEventId
                  ) {
                    continue;
                  }
                  pending.assistantMessageEventId = lastAssistantMessageEventId;
                  attachSelfModToAssistantMessage({
                    conversationId: payload.conversationId,
                    eventId: lastAssistantMessageEventId,
                    selfModApplied: {
                      commitHash,
                      files: pending.files,
                      batchIndex: 0,
                      status: "pending",
                    },
                  });
                }
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

      const delivered = await (
        await ensureRunnerInitialized()
      ).executeTool(
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
      // Tolerate the runner still building (post-ready window): nothing to
      // cancel if it hasn't started yet.
      state.runner?.cancelLocalChat((params as { runId: string }).runId);
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION,
    async (params) => {
      const cancelled =
        state.runner?.cancelLocalChatByConversation(
          (params as { conversationId: string }).conversationId,
        ) ?? false;
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
      const activeAgentRuns = runner?.listActiveAgentRuns() ?? [];
      const result: Array<{
        runId: string;
        conversationId: string;
        kind: "active" | "buffered";
        uiVisibility?: "visible" | "hidden";
      }> = [];
      const seenRunIds = new Set<string>();
      if (activeRun) {
        result.push({
          runId: activeRun.runId,
          conversationId: activeRun.conversationId,
          kind: "active",
        });
        seenRunIds.add(activeRun.runId);
      }
      for (const agentRun of activeAgentRuns) {
        if (seenRunIds.has(agentRun.runId)) continue;
        result.push({
          runId: agentRun.runId,
          conversationId: agentRun.conversationId,
          kind: "active",
          uiVisibility: "hidden",
        });
        seenRunIds.add(agentRun.runId);
      }
      const activeRunId = activeRun?.runId ?? null;
      for (const buffered of state.runEventLog?.listBufferedRuns() ?? []) {
        if (buffered.runId === activeRunId || seenRunIds.has(buffered.runId)) {
          continue;
        }
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
          provider?: string;
          externalMessageId?: string;
        };
      };
      const materializedImageAttachments = await materializeImageAttachments(
        payload.attachments,
      );
      return await (
        await ensureRunnerInitialized()
      ).runAutomationTurn({
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
      return await (
        await ensureRunnerInitialized()
      ).runBlockingLocalAgent({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT,
    async (params) => {
      const payload = params as RuntimeLocalAgentRequest;
      return await (
        await ensureRunnerInitialized()
      ).createBackgroundAgent({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT,
    async (params) => {
      // Tolerate the runner still building (post-ready window): a fresh worker
      // has no in-memory agent yet, so a missing snapshot is the right answer.
      return state.runner
        ? await state.runner.getLocalAgentSnapshot(
            (params as { agentId: string }).agentId,
          )
        : null;
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE,
    async (params) => {
      // Don't drop the message if the runner is still building (post-ready
      // window) — wait for the background build, then append.
      await joinRunnerBuild();
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
      return await (
        await ensureRunnerInitialized()
      ).webSearch(payload.query, {
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
          voiceSession?: { durationMs: number };
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
    METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG,
    async (params) => {
      return await ensureVoiceService().getOrchestratorConfig(
        params as {
          conversationId: string;
        },
      );
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_EXECUTE_TOOL,
    async (params) => {
      return await ensureVoiceService().executeTool(
        params as RuntimeVoiceToolCallPayload,
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
      "This release is backed by selected Stella source changes. Stella imports the source material directly when it applies cleanly, and asks an agent to adapt it only when the local tree has diverged.",
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
    const repoRoot = state.init.stellaAppDir;
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

    const gitArtifactBuild = await collectStoreReleaseGitArtifact({
      repoRoot,
      attachedFeatureNames,
      snapshot,
    });
    if (!gitArtifactBuild || gitArtifactBuild.objectUploads.length === 0) {
      throw new Error(
        "Could not build a git artifact for the selected changes. Try publishing a smaller, committed feature.",
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
      gitArtifact: gitArtifactBuild.gitArtifact,
      diff: gitArtifactBuild.diff,
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
      gitObjectUploads: gitArtifactBuild.objectUploads,
    };

    const runner = ensureRunner();
    return payload.asUpdate
      ? await runner.createStoreReleaseUpdate(publishArgs)
      : await runner.createFirstStoreRelease(publishArgs);
  };

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
        const beforeRemovalHead = await getGitHead(state.init.stellaAppDir).catch(
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
        const afterRemovalHead = await getGitHead(state.init.stellaAppDir).catch(
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
        gitArtifact?: StoreReleaseGitArtifact;
        diff?: string;
        commits?: StoreReleaseCommit[];
      };
      const runner = ensureRunner();
      const service = ensureStoreModService();

      const headBeforeRun = await getGitHead(init.stellaAppDir).catch(() => null);
      const baselineDirtyFiles = new Set(
        normalizeStoreInstallRollbackPaths(
          await listGitDirtyFiles(init.stellaAppDir).catch(() => []),
        ),
      );
      const existingInstall = service.getInstall(payload.packageId);
      const installApplyMode = existingInstall ? "update" : "install";
      try {
        const alreadyInstalledRevisionId =
          payload.gitArtifact &&
          existingInstall?.sourceRevisionIds.includes(
            `git:${payload.gitArtifact.featureCommit}`,
          )
            ? `git:${payload.gitArtifact.featureCommit}`
            : null;

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
          state.init.stellaDataDirPath,
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
        if (payload.diff) {
          const filePath = path.join(
            installRoot,
            "squashed-store-feature.diff",
          );
          await fsPromises.writeFile(filePath, payload.diff, "utf8");
          referencePaths.push(filePath);
        }
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
          await fsPromises.writeFile(
            filePath,
            `${header}${commit.diff}`,
            "utf8",
          );
          referencePaths.push(filePath);
        }

        if (alreadyInstalledRevisionId) {
          return service.recordInstall({
            packageId: payload.packageId,
            releaseNumber: payload.releaseNumber,
            installCommitHash: null,
            sourceRevisionId: alreadyInstalledRevisionId,
          });
        }

        const reviewResult = await (
          await loadOneShotCompletion()
        ).runOneShotCompletion({
          request: {
            agentType: "store_install_review",
            fallbackAgentTypes: ["general"],
            systemPrompt:
              "You are a no-tool safety reviewer for Stella Store installs. Return only the requested JSON decision.",
            userText: buildStoreInstallReviewPrompt({
              displayName: payload.displayName,
              packageId: payload.packageId,
              releaseSummary: payload.blueprintMarkdown,
              commits:
                payload.diff && commits.length === 0
                  ? [
                      {
                        hash:
                          payload.gitArtifact?.featureCommit ??
                          "squashed-store-feature",
                        subject: "Squashed Store feature diff",
                        diff: payload.diff,
                      },
                    ]
                  : commits,
            }),
            temperature: 0,
            maxOutputTokens: 700,
          },
          runtime: {
            stellaAppDir: init.stellaAppDir,
            stellaDataDir: init.stellaDataDirPath,
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
        const reviewDecision = parseStoreInstallReviewDecision(
          reviewResult.text,
        );
        if (!reviewDecision.allow) {
          throw new Error(
            `Store install review blocked this release: ${reviewDecision.reason}`,
          );
        }

        if (payload.gitArtifact) {
          const fastImportResult = await tryStoreGitArtifactFastPath({
            repoRoot: init.stellaAppDir,
            service,
            packageId: payload.packageId,
            releaseNumber: payload.releaseNumber,
            displayName: payload.displayName,
            gitArtifact: payload.gitArtifact,
            getObjectUrls: async (shas) =>
              await runner.getStoreGitObjectUrls(
                payload.packageId,
                payload.releaseNumber,
                shas,
              ),
            applyMode: installApplyMode,
            lifecycle: selfMod.externalLifecycle,
            log: (event, fields) => logger.info(event, fields),
          });
          if (fastImportResult.status === "applied") {
            return fastImportResult.installRecord;
          }
          const authorTreePath = await materializeStoreGitArtifactReference({
            repoRoot: init.stellaAppDir,
            gitArtifact: payload.gitArtifact,
            outputRoot: installRoot,
          }).catch(() => null);
          if (authorTreePath) {
            referencePaths.push(authorTreePath);
          }
        }

        const installPrompt = buildStoreInstallPrompt({
          displayName: payload.displayName,
          packageId: payload.packageId,
          installRootPath: installRoot,
          specPath,
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
        const headAfterRun = await getGitHead(state.init.stellaAppDir).catch(
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
        });
        return installRecord;
      } catch (error) {
        await rollbackFailedStoreInstall({
          repoRoot: init.stellaAppDir,
          startingHeadCommit: headBeforeRun,
          baselineDirtyFiles,
          packageId: payload.packageId,
          mode: installApplyMode,
        }).catch((rollbackError) => {
          logger.warn("store-install.rollback.failed", {
            packageId: payload.packageId,
            mode: installApplyMode,
            error: (rollbackError as Error).message,
          });
        });
        throw error;
      }
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_EXTERNAL_BEGIN,
    async (params) => {
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
      return await selfMod.externalLifecycle.beginExternalSelfMod({
        runId,
        paths,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_EXTERNAL_FINISH,
    async (params) => {
      const payload = params as { runId?: unknown; succeeded?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        throw new Error("External self-mod finish requires a runId.");
      }
      return await selfMod.externalLifecycle.finishExternalSelfMod({
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
    METHOD_NAMES.INTERNAL_WORKER_SOURCE_HISTORY_HAS_COMMIT,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { commitHash?: unknown };
      const commitHash =
        typeof payload?.commitHash === "string"
          ? payload.commitHash.trim()
          : "";
      if (!commitHash) {
        throw new Error("Source history commit lookup requires a commitHash.");
      }
      const record =
        ensureSourceHistoryStore().findRevisionByCommit(commitHash);
      return {
        ok: true,
        exists: Boolean(record),
        revisionId: record?.revisionId ?? null,
      };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR,
    async (params) => {
      // The host's signal that the morph cover for `transitionId` is on
      // screen and the worker can safely run the actual overlay apply +
      // release the runtime-reload pauses. The single-run `resume` API
      // is gone.
      const payload = params as
        | { transitionId?: string; runIds?: string[]; options?: ApplyOptions }
        | undefined;
      return await selfMod.resumeTransition(payload ?? {});
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
      if (reportTitle && reportHtml.trim() && state.init?.stellaDataDirPath) {
        const rawSlug =
          typeof firstReport?.slug === "string" ? firstReport.slug : "";
        const slug =
          rawSlug
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "welcome";
        const timestamp = Date.now();
        const filePath = path.join(
          state.init.stellaDataDirPath,
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
      const data = await collectBrowserData(state.init.stellaDataDirPath, {
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
        state.init.stellaDataDirPath,
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
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_APPLY,
    async (params) => {
      const payload = params as { commitHash?: string };
      if (!state.init) {
        await state.selfModHmrController?.forceResumeAll().catch((error) => {
          console.warn(
            "[self-mod-hmr] Failed to resume deferred self-mod state without apply handler:",
            (error as Error).message,
          );
        });
        return {
          commitHash: payload.commitHash,
          applied: false,
          message: "Self-mod apply handler is not available.",
        };
      }
      return await selfMod.applyPendingWithMorph({
        commitHash: payload.commitHash,
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_REVERT,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { commitHash?: string; steps?: number };
      return await selfMod.revertWithMorph({
        commitHash: payload.commitHash,
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
      const dirtyFiles = await listGitDirtyFiles(state.init.stellaAppDir);
      if (dirtyFiles.length > 0) {
        const mtimes = await Promise.all(
          dirtyFiles.map(async (file) => {
            try {
              const stat = await fsPromises.stat(
                path.join(state.init!.stellaAppDir, file),
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
      const [latestSelfModCommit = null] = await listRecentSelfModCommits(
        state.init.stellaAppDir,
        1,
      );
      return {
        kind: "clean",
        latestSelfModCommit,
      };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_DISCARD_UNFINISHED,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as { conversationId?: string } | undefined;
      const result = await discardGitDirtyFiles(state.init.stellaAppDir);
      if (result.discardedFileCount > 0) {
        recordSelfModRevertNotice({
          runtimeStore: state.runtimeStore,
          conversationId: asTrimmedString(payload?.conversationId),
          originThreadKey: null,
          commitHash: `unfinished:${crypto.randomUUID()}`,
          files: result.discardedFiles,
          logScope: "self-mod-discard-unfinished",
        });
      }
      return result;
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_LAST_COMMIT,
    async () => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      return await getLastSelfModCommitHash(state.init.stellaAppDir);
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_RECENT_COMMITS,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const rawLimit = (params as { limit?: number } | undefined)?.limit;
      const limit = Number.isFinite(rawLimit) ? Number(rawLimit) : 8;
      return await listRecentSelfModCommits(state.init.stellaAppDir, limit);
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
      return await (await loadOneShotCompletion()).runOneShotCompletion({
        request,
        runtime: {
          stellaAppDir: init.stellaAppDir,
          stellaDataDir: init.stellaDataDirPath,
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
    const activeRun =
      state.runner?.getActiveOrchestratorRun() ??
      state.runner?.listActiveAgentRuns()[0] ??
      null;
    return {
      ready: Boolean(state.runner?.agentHealthCheck().ready),
      hostPid: process.pid,
      workerPid: process.pid,
      workerRunning: true,
      workerGeneration: 0,
      deviceId: state.deviceId,
      activeRunId: activeRun?.runId ?? null,
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
