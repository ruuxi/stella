import { EventEmitter } from "node:events";
import {
  existsSync,
  promises as fs,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readConfiguredConvexUrl } from "../kernel/convex-urls.js";
import type { ConnectorTokenPayload } from "../kernel/connectors/oauth.js";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import { getFileLogger } from "../observability/file-logger.js";
import {
  hasRestartShutdownRecord,
  isRestartContinuationEnabled,
  writeRestartShutdownRecord,
} from "../kernel/restart-continuation.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import { createRemoteTurnBridge } from "../kernel/remote-turn-bridge.js";
import {
  isConvexDeviceKeyMismatchError,
  isConvexUnauthenticatedError,
  shouldStopRemoteTurnForAuthFailure,
} from "../kernel/runner/remote-turn-auth.js";
import type {
  LocalCronJobCreateInput,
  LocalCronJobUpdatePatch,
  LocalHeartbeatUpsertInput,
} from "../kernel/shared/scheduling.js";
import type { DiscoveryKnowledgeSeedPayload } from "../contracts/discovery.js";
import type {
  LocalChatUpdatedPayload,
  ThreadActivityUpdatedPayload,
} from "../contracts/local-chat.js";
import { createEmptySocialSessionServiceSnapshot } from "../contracts/index.js";
import { AGENT_STREAM_EVENT_TYPES } from "../contracts/agent-runtime.js";
import { resolveConnectorFollowupAction } from "./connector-followup.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type HostDeviceIdentity,
  type HostRuntimeAuthRefreshParams,
  type HostRuntimeAuthRefreshResult,
  type HostAppBrowserContextSnapshot,
  type HostDisplayUpdateParams,
  type HostHeartbeatSignature,
  type HostWindowTarget,
  type LocalCronJobRecord,
  type LocalHeartbeatConfigRecord,
  type RuntimeAgentEventPayload,
  type RuntimeAutomationTurnRequest,
  type RuntimeAutomationTurnResult,
  type RuntimeChatPayload,
  type RuntimeConfigureParams,
  type RuntimeCrashRecoveryStatus,
  type RuntimeDiscardUnfinishedResult,
  type RuntimeHealthSnapshot,
  type RuntimeSocialSessionStatus,
  type RuntimeSelfModApplyResult,
  type RuntimeSelfModRevertResult,
  type RuntimeLocalAgentRequest,
  type RuntimeLocalAgentSnapshot,
  type RuntimeOneShotCompletionRequest,
  type RuntimeOneShotCompletionResult,
  type RuntimeVoiceAgentEventPayload,
  type RuntimeVoiceChatPayload,
  type RuntimeVoiceHmrStatePayload,
  type RuntimeVoiceOrchestratorConfig,
  type RuntimeVoiceOrchestratorConfigRequest,
  type RuntimeVoiceToolCallPayload,
  type RuntimeVoiceToolCallResult,
  type RuntimeVoiceTranscriptPayload,
  type RuntimeWebSearchResult,
  type RunResumeEventsResult,
  type ScheduledConversationEvent,
  type SelfModFeatureRosterPage,
  type SelfModFeatureSnapshot,
  type SelfModCommitSummary,
  type SelfModHmrState,
  type StoreInstallRecord,
  type StorePackageRecord,
  type StorePackageReleaseRecord,
  type StorePublishArgs,
  type StorePublishSelectedFeaturesArgs,
  type StoreReleaseGitArtifact,
  type StoreReleaseSourcePack,
  type RuntimeInitializeParams,
  type RuntimeInitializeResult,
  type RuntimeModelCatalogSnapshot,
  type RuntimeListModelsRequest,
} from "../protocol/index.js";
import {
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "../protocol/rpc-peer.js";
import {
  RuntimeWorkerLifecycleController,
  type WorkerConnection,
  type WorkerHealthSnapshot,
  type WorkerLifecycleState,
} from "./worker-lifecycle.js";
import {
  buildUdsConnectionFactory,
  killDetachedWorker,
} from "./uds-connection.js";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import {
  computeRuntimeBuildStamp,
  RUNTIME_BUILD_STAMP_UNAVAILABLE,
} from "../worker/runtime-build-stamp.js";

type RuntimeHostEvents = {
  "runtime-connected": void;
  "runtime-disconnected": { reason: string };
  "runtime-ready": RuntimeHealthSnapshot;
  "runtime-reloading": { reason: string };
  "runtime-lagged": { droppedCount: number };
  "run-event": RuntimeAgentEventPayload;
  "run-self-mod-hmr-state": { runId?: string; state: SelfModHmrState };
  "voice-agent-event": RuntimeVoiceAgentEventPayload;
  "voice-self-mod-hmr-state": RuntimeVoiceHmrStatePayload;
  "local-chat-updated": LocalChatUpdatedPayload | null;
  "thread-activity-updated": ThreadActivityUpdatedPayload;
  "schedule-updated": void;
  "model-catalog-updated": RuntimeModelCatalogSnapshot;
};

type ConnectorFollowupTarget = {
  requestId: string;
  backendConversationId: string;
  initialTurnCompleted: boolean;
  pendingFollowupTexts: string[];
};

type ConnectorStreamBuffer = {
  requestId: string;
  backendConversationId: string;
  provider: string;
  text: string;
  revision: number;
  lastSentRevision: number;
  lastSentTextLength: number;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
};

const CONNECTOR_STREAM_FLUSH_INTERVAL_MS = 1_000;
const CONNECTOR_STREAM_BUFFER_THRESHOLD = 80;

export type RuntimeHostHandlers = {
  getActiveConversationId?: () => Promise<string | null> | string | null;
  getDeviceIdentity: () => Promise<HostDeviceIdentity>;
  resetDeviceIdentity?: () => Promise<HostDeviceIdentity>;
  signHeartbeatPayload: (signedAtMs: number) => Promise<HostHeartbeatSignature>;
  requestRuntimeAuthRefresh?: (
    params: HostRuntimeAuthRefreshParams,
  ) => Promise<HostRuntimeAuthRefreshResult>;
  getAppBrowserContext?: () =>
    | Promise<HostAppBrowserContextSnapshot>
    | HostAppBrowserContextSnapshot;
  requestCredential: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  /**
   * Performs connector token persistence in the desktop host, which delegates
   * to the configured stable protected-storage owner (the signed launcher on
   * macOS). Raw token payloads cross only the owner-only local runtime socket
   * and are never persisted outside the protected connector store.
   */
  requestConnectorTokenStore?: (
    request:
      | { operation: "load"; tokenKey: string }
      | {
          operation: "save";
          tokenKey: string;
          payload: ConnectorTokenPayload;
        }
      | { operation: "delete"; tokenKeys: string[] },
  ) => Promise<
    | { ok: true; payload?: ConnectorTokenPayload | null }
    | { ok: false; reason: string }
  >;
  /**
   * Pop a credential dialog for a connector token (Stella Connect MCP /
   * REST integrations). Unlike `requestCredential` the value is written
   * directly to `~/.stella/connectors/.credentials.json` via
   * `saveConnectorAccessToken` on the host — the secret never travels
   * back over IPC and is never inserted into Convex's `secrets` table.
   * Called from the worker's CLI bridge when `stella-connect call` /
   * `import-mcp` hits a 401/403. Returns `{ ok: true }` once persisted,
   * `{ ok: false, reason }` when the user dismisses the dialog or it
   * times out — the CLI propagates that as exit-2 `auth_required`.
   */
  requestConnectorCredential?: (payload: {
    tokenKey: string;
    displayName: string;
    /** `"oauth"` switches the host to the browser OAuth flow and requires `resourceUrl`. */
    authType?: "api_key" | "oauth";
    /** MCP server URL used for OAuth protected-resource metadata discovery. */
    resourceUrl?: string;
    oauthClientId?: string;
    oauthResource?: string;
    scopes?: string[];
    preregisteredOAuth?: {
      clientId: string;
      authorizationEndpoint: string;
      tokenEndpoint?: string;
      responseType?: "code" | "token";
      resourceUrl?: string;
      oauthResource?: string | null;
      callbackUrl?: string;
      callbackId?: string;
      callbackMode?: "local" | "external";
      scopeSeparator?: string;
      usesPkce?: boolean;
      authorizationRedirectParam?: string;
      authorizationParams?: Record<string, string>;
      tokenRedirectParam?: string;
      tokenAuth?: "body" | "basic";
      tokenExchange?: {
        type: "backend";
        provider: string;
      };
    };
    description?: string;
    placeholder?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  /**
   * Offer connecting a native Store integration via an inline connect
   * card in the active chat. The desktop owns the card UI plus the
   * enable + OAuth flow; the promise resolves when the user accepts
   * (and the flow finishes), declines, or the request times out.
   * Called from the worker's CLI bridge for
   * `stella-connect request-connection <id>`.
   */
  requestConnectorConnection?: (payload: {
    id: string;
    name: string;
    description?: string;
    iconUrl?: string;
    category?: string;
    reason?: string;
    /** Chat the card belongs to; the renderer scopes the card to it. */
    conversationId?: string;
    /** Worker-generated handle so a turn abort can cancel the card. */
    offerId?: string;
  }) => Promise<
    | { ok: true; status: "connected" | "already_connected" }
    | {
        ok: false;
        reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
      }
  >;
  /**
   * Cancel a pending connect card (connector or browser-extension) by
   * the worker-generated `offerId`. Fired when the originating turn is
   * aborted so the card doesn't linger until its own timeout.
   */
  cancelConnectorConnection?: (payload: {
    offerId: string;
  }) => Promise<{ ok: boolean }>;
  /**
   * Offer connecting the Stella browser extension via an inline card in
   * the active chat when a stella-browser command fails on the missing
   * extension bridge. Resolves when the user installs/connects the
   * extension, declines, or the request times out; on success the worker
   * re-runs the failed command automatically.
   */
  requestBrowserExtensionConnect?: (payload: {
    conversationId?: string;
    agentId?: string;
    command?: string;
    /** Worker-generated handle so a turn abort can cancel the card. */
    offerId?: string;
  }) => Promise<
    | { ok: true; status: "connected" | "already_connected" }
    | {
        ok: false;
        reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
      }
  >;
  requestComputerUseAppApproval?: (payload: {
    bundleIdentifier: string;
    displayName: string;
    appPath?: string;
    allowPersistentApproval: boolean;
    risk?: string;
    warningSubtitle?: string;
  }) => Promise<
    | { decision: "approved"; scope: "session" | "persistent" }
    | { decision: "declined"; scope: "none" }
  >;
  /**
   * Push a display update to the renderer. The payload is either a raw
   * HTML string or a structured payload object that the renderer hands
   * to its workspace panel tab manager. The host handler is responsible for forwarding
   * whatever it receives to the IPC `display:update` channel as-is so
   * the renderer can normalize it.
   */
  displayUpdate: (payload: Record<string, unknown>) => Promise<void> | void;
  showNotification?: (payload: {
    title: string;
    body: string;
    sound?: string;
  }) => Promise<void> | void;
  requestDesktopPermission?: (kind: "accessibility" | "screen") => Promise<{
    granted: boolean;
    alreadyGranted: boolean;
  }>;
  openExternal?: (url: string) => Promise<void> | void;
  showWindow?: (target: HostWindowTarget) => Promise<void> | void;
  focusWindow?: (target: HostWindowTarget) => Promise<void> | void;
  runHmrTransition?: (payload: {
    /**
     * The run ids in the apply batch that this morph cover wraps. Used by
     * the host for diagnostics and for tagging the post-apply screenshot.
     */
    runIds: string[];
    /**
     * Visible root run ids that should receive transition state events.
     * These can differ from runIds, which are internal self-mod run ids used
     * by the worker for apply/release bookkeeping.
     */
    stateRunIds?: string[];
    requiresFullReload: boolean;
    requiresRuntimeRestart?: boolean;
    requiresProcessRestart?: boolean;
    /**
     * Triggers the worker-side overlay apply for this batch (POSTs `/apply`
     * to the Vite plugin). Called by the host once the morph cover is on
     * screen so the renderer never visibly crosses the swap.
     */
    applyBatch: (options?: {
      suppressClientFullReload?: boolean;
      forceClientFullReload?: boolean;
    }) => Promise<{ requiresClientFullReload?: boolean } | void>;
    reportState?: (state: SelfModHmrState) => Promise<void> | void;
  }) => Promise<void> | void;
};

export type StellaRuntimeHostOptions = {
  workerEntryPath?: string;
  hostHandlers: RuntimeHostHandlers;
  initializeParams: Omit<RuntimeInitializeParams, "protocolVersion">;
};

type WorkerInitializationState = {
  protocolVersion: string;
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

const AGENT_EVENT_BUFFER_LIMIT = 1_000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1_000;
const SELF_MOD_RUNTIME_RELOAD_STATE_FILE = ".stella-runtime-reload-state.json";
const DEVICE_HEARTBEAT_INTERVAL_MS = 30_000;
const SYNTHETIC_RUN_EVENT_SEQ_FLOOR = 1e10;

type RemoteTurnAuthSource = HostRuntimeAuthRefreshParams["source"];

const parseDisplayUpdateParams = (params: unknown): Record<string, unknown> => {
  if (params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    if (record.payload && typeof record.payload === "object") {
      return record.payload as Record<string, unknown>;
    }
    if (typeof record.kind === "string") {
      return record;
    }
  }
  throw new Error("Invalid host display update payload.");
};

const pruneAgentEventBuffers = (
  buffers: Map<
    string,
    { events: RuntimeAgentEventPayload[]; updatedAt: number }
  >,
) => {
  const now = Date.now();
  for (const [runId, buffer] of buffers.entries()) {
    if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
      buffers.delete(runId);
    }
  }
};

const bufferAgentEvent = (
  buffers: Map<
    string,
    { events: RuntimeAgentEventPayload[]; updatedAt: number }
  >,
  event: RuntimeAgentEventPayload,
) => {
  const existing = buffers.get(event.runId);
  if (existing) {
    existing.events.push(event);
    if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
      existing.events.splice(
        0,
        existing.events.length - AGENT_EVENT_BUFFER_LIMIT,
      );
    }
    existing.updatedAt = Date.now();
    return;
  }
  buffers.set(event.runId, { events: [event], updatedAt: Date.now() });
};

/**
 * "Busy" for the purposes of stale-worker restarts: anything that a worker
 * kill would visibly interrupt. `activeRun`/`activeAgentCount` come from the
 * worker's active-run registry (the authoritative in-flight signal); voice
 * fields cover a live voice orchestrator turn. A `null` health snapshot
 * means the worker is unreachable, so there is nothing to preserve.
 */
export const isWorkerBusyForRestart = (
  health: Pick<
    WorkerHealthSnapshot,
    "activeRun" | "activeAgentCount" | "voiceBusy" | "pendingVoiceRequestCount"
  > | null,
): boolean =>
  health != null &&
  (health.activeRun != null ||
    health.activeAgentCount > 0 ||
    health.voiceBusy === true ||
    (health.pendingVoiceRequestCount ?? 0) > 0);

export const shouldAckWorkerRunEvent = (
  event: Pick<RuntimeAgentEventPayload, "seq" | "type">,
): boolean => {
  if (!Number.isFinite(event.seq)) return false;
  if (event.seq >= SYNTHETIC_RUN_EVENT_SEQ_FLOOR) return false;
  return event.type !== AGENT_STREAM_EVENT_TYPES.RUN_FINISHED;
};

export class StellaRuntimeHost {
  private readonly events = new EventEmitter();
  private readonly agentEventBuffers = new Map<
    string,
    { events: RuntimeAgentEventPayload[]; updatedAt: number }
  >();
  private readonly workerController: RuntimeWorkerLifecycleController;
  private workerHealthCache: WorkerHealthSnapshot | null = null;
  private schedulerService: LocalSchedulerService | null = null;
  private schedulerSubscription: (() => void) | null = null;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private deferredRuntimeReload = false;
  // Coalescing for the dev-watcher / self-mod reload path only: while a
  // scheduled reload's restart is queued or running, further reload requests
  // collapse into a single trailing re-run instead of stacking one full restart
  // per file event. This does NOT guard direct restartWorker() callers (e.g.
  // the runtime.restartWorker IPC action) — those run their own full restart;
  // the controller's stop/start promises keep concurrent calls safe.
  private restartInProgress = false;
  private restartRequestedDuringRestart = false;
  // Number of self-mod morph transitions the renderer is currently covering
  // (bracketed around every HOST_HMR_RUN_TRANSITION handler run). A runtime
  // worker restart that fires WHILE a morph is on screen kills the worker mid
  // `finishExternalSelfMod`, closing the RPC transport under the in-flight
  // desktop-update finish. The update handler's transport-closed recovery then
  // replays a fresh begin/finish cycle over the same paths, which raises a
  // SECOND morph cover on its own after the update already applied. Gating the
  // deferred restart on this counter keeps the worker alive until the morph
  // fully lifts, so the update's morph plays exactly once.
  private morphTransitionsInFlight = 0;
  /**
   * Set when the connected worker is known to be running stale runtime code
   * (build-stamp mismatch detected on reattach, or a runtime-relevant
   * self-mod apply landed) but the restart was deferred because work is in
   * flight. Mirrored to `pendingWorkerRestartFile` on disk so the flag
   * survives an Electron restart; cleared whenever a freshly spawned worker
   * connects (fresh worker == current code).
   */
  private pendingStaleWorkerRestart: {
    reason: string;
    detectedAtMs: number;
  } | null = null;
  private staleWorkerQuiescencePollTimer: ReturnType<
    typeof setInterval
  > | null = null;
  // Serializes the single gated flush (`flushWorkerRestart`) so concurrent
  // triggers/hooks don't stack overlapping health probes or restarts.
  private workerRestartCheckInFlight = false;
  // runId -> pausedAtMs. The timestamp drives the leak backstop: a pause is
  // normally released by the worker's apply lifecycle within seconds, so one
  // that outlives the TTL (or its run) is treated as leaked and force-cleared
  // rather than deferring reloads/restarts forever.
  private readonly pausedRuntimeReloadRuns = new Map<string, number>();
  private pausedRuntimeReloadSweepTimer: ReturnType<
    typeof setInterval
  > | null = null;
  private reloadQueue = Promise.resolve();
  private configCache: RuntimeConfigureParams = {};
  private deviceIdentity: HostDeviceIdentity | null = null;
  private workerGeneration = 0;
  private started = false;
  private hostReady = false;
  private hostConvexClient: ConvexClient | null = null;
  private hostConvexClientUrl: string | null = null;
  private hostConvexClientAuthToken: string | null = null;
  private hostRemoteTurnBridge: ReturnType<
    typeof createRemoteTurnBridge
  > | null = null;
  private hostDeviceRegistered = false;
  private hostDeviceRegistering = false;
  private hostHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private hostRemoteTurnAuthWindowStartedAt = 0;
  private hostRemoteTurnUnauthenticatedFailures = 0;
  private hostRemoteTurnAuthRecoveryPromise: Promise<boolean> | null = null;
  private hostDeviceIdentityRecoveryPromise: Promise<boolean> | null = null;
  private pendingRunEventAcks = new Map<string, number>();
  private runEventAckTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-conversation routing for follow-up assistant messages. Set when a
   * connector-sourced user message kicks off an orchestrator turn; cleared
   * when the user sends a non-connector message in that conversation
   * (i.e. they came back to the desktop). While a target is armed, every
   * assistant message persisted for that local conversation gets shipped
   * back to the same channel via `sendConnectorFollowup` so multi-turn
   * work (spawned-agent completion notices, "and here's the result" follow
   * ups, etc.) reaches the phone instead of dead-ending on the desktop.
   */
  private connectorTargetsByLocalConversation = new Map<
    string,
    ConnectorFollowupTarget
  >();
  private connectorStreamBuffersByRequestId = new Map<
    string,
    ConnectorStreamBuffer
  >();
  /**
   * Reverse index of `connectorTargetsByLocalConversation` keyed by
   * `requestId`. Used by the cancel subscription to map an inbound
   * cancellation back to the active local conversation so we can call
   * `cancelChatByConversation` on the worker. Maintained alongside the
   * primary map: any write here happens immediately after a write there.
   */
  private localConversationByRequestId = new Map<string, string>();
  /**
   * Tracks requestIds we've already actioned a cancel for, so reconnects
   * to `subscribeRemoteTurnCancelsForDevice` (which keeps returning
   * cancelled rows for the lookback window) don't fire repeat aborts.
   */
  private cancelledRequestIds = new Set<string>();
  private hostRemoteTurnCancelUnsubscribe: (() => void) | null = null;

  constructor(private readonly options: StellaRuntimeHostOptions) {
    const stellaAppDir = this.options.initializeParams.stellaAppDir;
    const udsFactory = buildUdsConnectionFactory({
      stellaAppDir,
      expectedProtocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
      hostExecutablePath: process.execPath,
      onError: (error) => {
        console.error("[runtime-host] worker RPC error:", error);
      },
    });
    this.workerController = new RuntimeWorkerLifecycleController({
      workerEntryPath: resolveDefaultWorkerEntryPath(this.options),
      isHostStarted: () => this.started,
      // Worker self-supervises in the UDS path. Closing the IPC channel
      // (stop "stopped" / "idle") leaves the worker running for the next
      // host to attach; only "restart" actually kills the pid.
      killWorkerOnStop: (reason) => reason === "restart",
      killWorker: async () => {
        await killDetachedWorker(stellaAppDir);
      },
      createConnectionAsync: udsFactory,
      initializeConnection: async (connection) => {
        await this.resetRuntimeReloadPauses();
        this.registerHostHandlers(connection.peer);
        this.registerNotifications(connection.peer);
        const initializeResult =
          await connection.peer.request<RuntimeInitializeResult>(
            METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
            this.buildWorkerInitializationState(),
          );
        if (
          initializeResult.protocolVersion !== STELLA_RUNTIME_PROTOCOL_VERSION
        ) {
          throw new Error(
            `Runtime worker protocol mismatch: host=${STELLA_RUNTIME_PROTOCOL_VERSION} worker=${initializeResult.protocolVersion ?? "unknown"}.`,
          );
        }
        if (Object.keys(this.configCache).length > 0) {
          await connection.peer.request(
            METHOD_NAMES.INTERNAL_WORKER_CONFIGURE,
            this.configCache,
          );
        }
      },
      onConnectionStarted: async (connection) => {
        this.workerGeneration += 1;
        getFileLogger()?.process("host.worker-connected", {
          pid: connection.pid,
          generation: this.workerGeneration,
          attached: connection.attachedToExistingWorker === true,
        });
        this.workerHealthCache = await this.workerController.getHealth({
          ensureWorker: false,
        });
        try {
          await this.evaluateWorkerStalenessOnConnect(connection);
        } catch (error) {
          console.warn(
            "[runtime-host] Worker staleness handshake failed:",
            (error as Error).message,
          );
        }
        this.events.emit("runtime-ready", await this.health());
      },
      onUnexpectedExit: async () => {
        getFileLogger()?.error("host.worker-unexpected-exit", {
          generation: this.workerGeneration,
        });
        this.workerHealthCache = null;
        if (this.started) {
          this.events.emit("runtime-ready", await this.health());
        }
      },
      onAfterStop: async (reason) => {
        // "idle" closes the IPC channel but leaves the worker alive for the
        // next host to reattach — routine churn, not a real stop. Only log
        // when the worker process is actually being torn down.
        if (reason !== "idle") {
          getFileLogger()?.process("host.worker-stopped", { reason });
        }
        this.workerHealthCache = null;
        if (this.started) {
          this.events.emit("runtime-reloading", { reason: `worker-${reason}` });
          this.events.emit("runtime-ready", await this.health());
        }
      },
      onStateChange: (_state: WorkerLifecycleState) => {
        if (_state === "idle" && !this.workerController.getConnection()) {
          this.workerHealthCache = null;
        }
      },
      fetchHealth: async (connection: WorkerConnection) => {
        const snapshot = await connection.peer.request<WorkerHealthSnapshot>(
          METHOD_NAMES.INTERNAL_WORKER_HEALTH,
        );
        this.workerHealthCache = snapshot;
        return snapshot;
      },
    });
  }

  /*
   * The detached worker keeps agent runs, shell/tool execution, and the
   * persistent run-event log alive across an Electron restart. Host-owned
   * services below still pause during the gap: LocalSchedulerService,
   * remote-turn Convex subscriptions, device heartbeats, dev file watching,
   * and the runtime-reload state-file writer. Those surfaces are expected
   * to recover on host reconnect; they are not part of the sidecar's
   * survival guarantee.
   */

  private getRuntimeReloadStateFilePath() {
    return path.join(
      this.options.initializeParams.stellaAppDir,
      SELF_MOD_RUNTIME_RELOAD_STATE_FILE,
    );
  }

  private async persistRuntimeReloadPauseState() {
    if (!this.options.initializeParams.isDev) {
      return;
    }
    const filePath = this.getRuntimeReloadStateFilePath();
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          paused: this.pausedRuntimeReloadRuns.size > 0,
          pid: process.pid,
          updatedAtMs: Date.now(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  private async pauseRuntimeReloads(runId: string) {
    this.pausedRuntimeReloadRuns.set(runId, Date.now());
    this.startPausedRuntimeReloadSweep();
    await this.persistRuntimeReloadPauseState();
  }

  private async resumeRuntimeReloads(
    runId: string,
    options?: { allowDeferredReload?: boolean },
  ) {
    this.pausedRuntimeReloadRuns.delete(runId);
    await this.persistRuntimeReloadPauseState();
    if (this.pausedRuntimeReloadRuns.size > 0) {
      return;
    }
    this.stopPausedRuntimeReloadSweep();
    // The last self-mod pause released. A process-restart apply opts out of an
    // immediate worker reload for this release (`allowDeferredReload: false`) —
    // drop that intent, but still let a persisted stale restart proceed.
    if (options?.allowDeferredReload === false) {
      this.deferredRuntimeReload = false;
    }
    void this.flushWorkerRestart();
  }

  private async resetRuntimeReloadPauses() {
    this.pausedRuntimeReloadRuns.clear();
    this.stopPausedRuntimeReloadSweep();
    await this.persistRuntimeReloadPauseState();
    // Pauses were force-cleared (the worker reinitialized underneath held
    // runs). Any deferred reload / pending stale restart intent survives and
    // can now be re-evaluated through the unified gate.
    void this.flushWorkerRestart();
  }

  /**
   * Leak backstops for runtime-reload pauses. A pause is acquired by the
   * worker around a self-mod apply and normally released within seconds by
   * the same lifecycle. Two observed ways that release never happens:
   *  - the apply's morph transition dies between dispatch and resume (e.g.
   *    an Electron restart replays into `unknown-transition`), or
   *  - the owning run is killed without its cleanup running.
   * A leaked pause silently blocks every worker reload and restart — dev
   * reloads stop landing and a pending desktop update defers forever. So:
   * pauses older than the TTL are force-released by a slow sweep, and a
   * pause whose run reports RUN_FINISHED is force-released after a short
   * grace window.
   */
  private forceReleaseRuntimeReloadPause(runId: string, reason: string) {
    if (!this.pausedRuntimeReloadRuns.delete(runId)) {
      return;
    }
    getFileLogger()?.warn("host.runtime-reload-pause-force-released", {
      runId,
      reason,
    });
    console.warn(
      `[runtime-host] Force-released a leaked self-mod reload pause (run ${runId}, ${reason}).`,
    );
    if (this.pausedRuntimeReloadRuns.size === 0) {
      this.stopPausedRuntimeReloadSweep();
    }
    void this.persistRuntimeReloadPauseState().catch(() => undefined);
    void this.flushWorkerRestart();
  }

  private getRuntimeReloadPauseTtlMs(): number {
    const raw = process.env.STELLA_SELF_MOD_RELOAD_PAUSE_TTL_MS?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
  }

  private startPausedRuntimeReloadSweep() {
    if (this.pausedRuntimeReloadSweepTimer) return;
    this.pausedRuntimeReloadSweepTimer = setInterval(() => {
      const ttlMs = this.getRuntimeReloadPauseTtlMs();
      const now = Date.now();
      for (const [runId, pausedAtMs] of this.pausedRuntimeReloadRuns) {
        if (now - pausedAtMs >= ttlMs) {
          this.forceReleaseRuntimeReloadPause(
            runId,
            `held for ${Math.round((now - pausedAtMs) / 1000)}s, TTL ${Math.round(ttlMs / 1000)}s`,
          );
        }
      }
    }, 60_000);
    this.pausedRuntimeReloadSweepTimer.unref?.();
  }

  private stopPausedRuntimeReloadSweep() {
    if (!this.pausedRuntimeReloadSweepTimer) return;
    clearInterval(this.pausedRuntimeReloadSweepTimer);
    this.pausedRuntimeReloadSweepTimer = null;
  }

  /**
   * RUN_FINISHED hook for the run-liveness backstop: a finished run can no
   * longer legitimately hold a reload pause, but its release RPC may still
   * be in flight — give it a short grace window before force-clearing.
   */
  private scheduleRuntimeReloadPauseReleaseForFinishedRun(runId: string) {
    if (!this.pausedRuntimeReloadRuns.has(runId)) {
      return;
    }
    const pausedAtMs = this.pausedRuntimeReloadRuns.get(runId);
    const timer = setTimeout(() => {
      // Only release the exact acquisition we observed at RUN_FINISHED; a
      // newer timestamp means the pause was re-acquired since (by a replay
      // for the same run) and gets its own TTL treatment.
      if (this.pausedRuntimeReloadRuns.get(runId) === pausedAtMs) {
        this.forceReleaseRuntimeReloadPause(runId, "run finished");
      }
    }, 30_000);
    timer.unref?.();
  }

  /**
   * Bracket a self-mod morph transition so runtime restarts can't fire while
   * the cover is on screen. Runs the transition, then flushes any restart that
   * was deferred to avoid killing the worker mid-morph.
   */
  private async withMorphTransitionInFlight(
    run: () => void | Promise<void>,
  ): Promise<void> {
    this.morphTransitionsInFlight += 1;
    try {
      await run();
    } finally {
      this.onMorphTransitionSettled();
    }
  }

  private onMorphTransitionSettled() {
    this.morphTransitionsInFlight = Math.max(
      0,
      this.morphTransitionsInFlight - 1,
    );
    if (this.morphTransitionsInFlight > 0) return;
    // The morph cover has fully lifted; re-evaluate any deferred worker
    // restart through the unified gate.
    void this.flushWorkerRestart();
  }

  /**
   * Dev dist-electron watcher trigger: `runtime/` worker code changed on disk.
   * Records the reload intent and debounces a gated flush. The actual restart
   * only proceeds when {@link canRestartWorkerNow} holds (no self-mod pause, no
   * morph cover, worker not busy) — evaluated authoritatively in
   * `flushWorkerRestart`.
   */
  private scheduleRuntimeReload() {
    this.deferredRuntimeReload = true;
    // Only arm the debounce timer when no LOCAL blocker (self-mod pause / morph
    // cover) is active: a blocked call leaves the intent for an unblock hook
    // (pause release, morph settle, worker idle) to flush, and never leaves a
    // stray timer that could fire mid-block. Worker-busy is evaluated with
    // fresh health inside `flushWorkerRestart`.
    if (
      this.pausedRuntimeReloadRuns.size > 0 ||
      this.morphTransitionsInFlight > 0
    ) {
      return;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.flushWorkerRestart();
    }, 150);
  }

  /*
   * ---- Stale-worker detection + idle/deferred restart -------------------
   *
   * The detached worker survives Electron restarts by design (grace window
   * that preserves in-flight runs). Without this machinery, runtime code
   * changes (self-mod applies, desktop updates) never reach a surviving
   * worker: the new host reconnects and keeps running old code forever.
   *
   * On every reattach we compare the worker's boot-time build stamp with the
   * on-disk runtime tree. Stale + idle => restart immediately. Stale + busy
   * => mark "restart pending" (persisted, survives further Electron
   * restarts) and restart the moment the worker goes quiescent — checked on
   * every RUN_FINISHED plus a slow safety poll. Auto-resuming runs killed by
   * a restart is intentionally out of scope for v1: deferral means we never
   * kill in-flight work in the first place.
   */

  private getRuntimeControlPaths() {
    return resolveRuntimePaths(this.options.initializeParams.stellaAppDir);
  }

  private readWorkerReportedBuildStamp(): string | null {
    try {
      const raw = readFileSync(
        this.getRuntimeControlPaths().buildStampFile,
        "utf-8",
      ).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  private hasPersistedPendingWorkerRestart(): boolean {
    return existsSync(this.getRuntimeControlPaths().pendingWorkerRestartFile);
  }

  getPendingWorkerRestart() {
    return this.pendingStaleWorkerRestart;
  }

  private async markPendingWorkerRestart(reason: string) {
    if (!this.pendingStaleWorkerRestart) {
      this.pendingStaleWorkerRestart = { reason, detectedAtMs: Date.now() };
    }
    getFileLogger()?.process("host.worker-restart-pending", { reason });
    console.warn(
      `[runtime-host] Runtime update pending (${reason}); the worker restarts when current work finishes.`,
    );
    try {
      const paths = this.getRuntimeControlPaths();
      await fs.mkdir(paths.rootDir, { recursive: true });
      await fs.writeFile(
        paths.pendingWorkerRestartFile,
        JSON.stringify(this.pendingStaleWorkerRestart, null, 2),
        "utf-8",
      );
    } catch (error) {
      console.warn(
        "[runtime-host] Failed to persist pending worker restart flag:",
        (error as Error).message,
      );
    }
    this.startStaleWorkerQuiescencePoll();
    // Nudge the unified gate soon: restart now if already quiescent, otherwise
    // an unblock hook (pause release, morph settle, worker idle) or the poll
    // retries. Off this call stack so a caller still inside the startup /
    // apply sequence isn't restarted from under itself.
    const nudge = setTimeout(() => {
      void this.flushWorkerRestart();
    }, 1_000);
    nudge.unref?.();
    if (this.started) {
      this.events.emit("runtime-ready", await this.health());
    }
  }

  private async clearPendingWorkerRestart() {
    this.stopStaleWorkerQuiescencePoll();
    this.pendingStaleWorkerRestart = null;
    await fs
      .unlink(this.getRuntimeControlPaths().pendingWorkerRestartFile)
      .catch(() => undefined);
  }

  private startStaleWorkerQuiescencePoll() {
    if (this.staleWorkerQuiescencePollTimer) return;
    // Safety net for busy signals that don't end in a RUN_FINISHED event
    // (e.g. voice-only activity) or a missed event during churn.
    this.staleWorkerQuiescencePollTimer = setInterval(() => {
      void this.flushWorkerRestart();
    }, 30_000);
    this.staleWorkerQuiescencePollTimer.unref?.();
  }

  private stopStaleWorkerQuiescencePoll() {
    if (!this.staleWorkerQuiescencePollTimer) return;
    clearInterval(this.staleWorkerQuiescencePollTimer);
    this.staleWorkerQuiescencePollTimer = null;
  }

  /**
   * Reconnect handshake: decide whether the worker we just connected to is
   * running stale runtime code. Runs from `onConnectionStarted` after the
   * health snapshot is cached.
   */
  private async evaluateWorkerStalenessOnConnect(connection: WorkerConnection) {
    if (connection.attachedToExistingWorker !== true) {
      // Freshly spawned worker loaded the current on-disk code; any deferred
      // restart bookkeeping from a previous generation is now satisfied.
      await this.clearPendingWorkerRestart();
      return;
    }
    let reason: string | null = null;
    if (this.hasPersistedPendingWorkerRestart()) {
      reason = "pending-restart-flag";
    } else {
      const workerStamp = this.readWorkerReportedBuildStamp();
      if (!workerStamp) {
        // Pre-stamp worker (older build) — by definition running old code.
        reason = "worker-stamp-missing";
      } else {
        const onDiskStamp = computeRuntimeBuildStamp(
          resolveDefaultWorkerEntryPath(this.options),
        );
        if (
          onDiskStamp !== RUNTIME_BUILD_STAMP_UNAVAILABLE &&
          workerStamp !== onDiskStamp
        ) {
          reason = "build-stamp-mismatch";
        }
      }
    }
    if (!reason) {
      await this.clearPendingWorkerRestart();
      return;
    }
    getFileLogger()?.process("host.worker-stale-detected", {
      reason,
      pid: connection.pid,
    });
    console.warn(
      `[runtime-host] Reconnected to a stale runtime worker (pid=${connection.pid}, ${reason}).`,
    );
    // `markPendingWorkerRestart` starts the quiescence poll and nudges the
    // unified gate; a run that starts in the meantime re-defers instead of
    // being killed.
    await this.markPendingWorkerRestart(reason);
  }

  /**
   * Runtime-relevant self-mod apply landed while no dev watcher is running
   * (packaged/prod: the dev dist-electron watcher otherwise owns this).
   * Same policy as the reconnect handshake: idle => restart now; busy =>
   * pending restart, persisted so it survives the Electron relaunch that a
   * process-restart-classified apply triggers.
   */
  private async noteRuntimeCodeChangedByApply(reason: string) {
    // `markPendingWorkerRestart` persists the flag, starts the quiescence
    // poll, and nudges the unified gate (which does its own fresh-health
    // busy check before restarting).
    await this.markPendingWorkerRestart(reason);
  }

  /**
   * Restart-with-continuation shutdown record. Written synchronously and
   * best-effort at every restart-initiation point (worker restart, host
   * stop). The record is deliberately minimal — reason + timestamp — because
   * the interrupted-thread set is derived at next boot from the durable
   * `runtime_agents` rows still marked `running` (which survive even a hard
   * kill that skips this write). The next worker boot consumes the record
   * exactly once; a stale record is discarded there.
   */
  private writeRestartContinuationRecord(
    reason: string,
    options?: { skipIfPresent?: boolean },
  ) {
    if (!isRestartContinuationEnabled(process.env)) return;
    const stellaDataDir = this.options.initializeParams?.stellaDataDirPath;
    if (!stellaDataDir) return;
    try {
      if (options?.skipIfPresent && hasRestartShutdownRecord(stellaDataDir)) {
        return;
      }
      const written = writeRestartShutdownRecord(stellaDataDir, { reason });
      if (written) {
        getFileLogger()?.process("host.restart-continuation-record", {
          reason,
        });
      }
    } catch {
      // Best-effort — never let continuation bookkeeping break a shutdown.
    }
  }

  /**
   * Unified gate for restarting the runtime worker. A restart may only proceed
   * when NONE of the blockers hold:
   *   - a per-run self-mod reload PAUSE is active (a self-mod / desktop update
   *     is mid-apply);
   *   - a morph cover is on screen (restarting mid-morph closes the RPC
   *     transport under an in-flight desktop-update finish and forces a
   *     redundant second morph via the transport-closed reload-replay);
   *   - the worker is busy (an agent run / voice request is in flight).
   * Both restart triggers (dev dist-electron watcher, stale-worker detection)
   * and every unblock hook route through this, so the dev-watcher path honors
   * the worker-busy deferral exactly like the stale-worker path.
   */
  private canRestartWorkerNow(
    health: WorkerHealthSnapshot | null = this.workerHealthCache,
  ): boolean {
    return (
      this.pausedRuntimeReloadRuns.size === 0 &&
      this.morphTransitionsInFlight === 0 &&
      !isWorkerBusyForRestart(health)
    );
  }

  /**
   * Whether some trigger wants the worker restarted: a dev-watcher runtime
   * reload (`deferredRuntimeReload`) or a persisted stale-worker restart
   * (`pendingStaleWorkerRestart`).
   */
  private hasPendingWorkerRestartIntent(): boolean {
    return this.deferredRuntimeReload || this.pendingStaleWorkerRestart != null;
  }

  /**
   * The single flush path for BOTH restart triggers and every unblock hook
   * (self-mod pause release, morph settle, worker idle / RUN_FINISHED,
   * quiescence poll). Re-evaluates {@link canRestartWorkerNow} against fresh
   * worker health and restarts once every blocker has cleared. A single
   * restart satisfies both intents: `restartWorker()` clears the
   * deferred-reload flag and a freshly spawned worker clears the pending flag
   * on reconnect.
   */
  private async flushWorkerRestart() {
    if (!this.started || !this.hasPendingWorkerRestartIntent()) return;
    if (this.workerRestartCheckInFlight) return;
    this.workerRestartCheckInFlight = true;
    try {
      // Cheap synchronous blockers first — never probe worker health while a
      // self-mod pause is held or a morph cover is on screen.
      if (
        this.pausedRuntimeReloadRuns.size > 0 ||
        this.morphTransitionsInFlight > 0
      ) {
        return;
      }
      const health = await this.getWorkerHealth({ ensureWorker: false }).catch(
        () => null,
      );
      if (!this.canRestartWorkerNow(health)) return;
      this.executeWorkerRestart();
    } finally {
      this.workerRestartCheckInFlight = false;
    }
  }

  /**
   * Perform the gated restart through the shared reload queue / in-progress
   * coalescing. Re-checks {@link canRestartWorkerNow} against fresh health
   * immediately before the kill so a run that started while queued is never
   * cut down — the pending intent stays set and a later flush retries.
   */
  private executeWorkerRestart() {
    if (this.restartInProgress) {
      this.restartRequestedDuringRestart = true;
      return;
    }
    this.restartInProgress = true;
    this.reloadQueue = this.reloadQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          if (!this.started || !this.hasPendingWorkerRestartIntent()) return;
          if (
            this.pausedRuntimeReloadRuns.size > 0 ||
            this.morphTransitionsInFlight > 0
          ) {
            return;
          }
          const health = await this.getWorkerHealth({
            ensureWorker: false,
          }).catch(() => null);
          if (!this.canRestartWorkerNow(health)) return;
          const reason =
            this.pendingStaleWorkerRestart?.reason ?? "runtime-reload";
          // Consume the watcher intent before the replacement worker starts.
          // Worker initialization resets reload pauses and flushes pending
          // restart intent; leaving this bit set there re-arms the restart
          // forever, producing a spawn/ready/kill loop until Electron exits.
          const consumedDeferredRuntimeReload = this.deferredRuntimeReload;
          this.deferredRuntimeReload = false;
          getFileLogger()?.process("host.worker-restart", { reason });
          console.warn(`[runtime-host] Restarting runtime worker (${reason}).`);
          // Restart-with-continuation: the replacement worker's boot sweep
          // joins this record against the durable thread rows to decide
          // whether interrupted agent work should be auto-resumed.
          this.writeRestartContinuationRecord(reason);
          try {
            await this.restartWorker();
          } catch (error) {
            // A failed restart did not satisfy the watcher request. Preserve it
            // for the next explicit readiness/recovery attempt.
            if (consumedDeferredRuntimeReload) {
              this.deferredRuntimeReload = true;
            }
            throw error;
          }
        } finally {
          this.restartInProgress = false;
          if (this.restartRequestedDuringRestart) {
            this.restartRequestedDuringRestart = false;
            setTimeout(() => {
              void this.flushWorkerRestart();
            }, 0);
          }
          // `restartWorker()` emits readiness while restartInProgress is still
          // true, so that snapshot intentionally remains send-blocked. Publish
          // the authoritative post-transition state after clearing the flag so
          // waitUntilReady callers are released without polling or retrying.
          if (this.started) {
            void this.health().then((snapshot) => {
              this.events.emit("runtime-ready", snapshot);
            });
          }
        }
      });
  }

  private getConfiguredHostAuthToken() {
    return this.configCache.authToken?.trim() || null;
  }

  private getConfiguredHostConvexUrl() {
    return readConfiguredConvexUrl(this.configCache.convexUrl ?? null);
  }

  private getHostDeviceName() {
    const hostname = os.hostname().trim();
    if (hostname) {
      return hostname;
    }
    const fallbackDeviceId = this.deviceIdentity?.deviceId ?? "unknown";
    return `${process.platform}-${fallbackDeviceId.slice(0, 6)}`;
  }

  private async getActiveLocalConversationId() {
    const activeConversationId =
      (await this.options.hostHandlers.getActiveConversationId?.())?.trim() ??
      "";
    return (
      activeConversationId || (await this.getOrCreateDefaultConversationId())
    );
  }

  private stopHostHeartbeatLoop() {
    if (this.hostHeartbeatTimer) {
      clearInterval(this.hostHeartbeatTimer);
      this.hostHeartbeatTimer = null;
    }
  }

  private resetHostRemoteTurnAuthTracking() {
    this.hostRemoteTurnAuthWindowStartedAt = Date.now();
    this.hostRemoteTurnUnauthenticatedFailures = 0;
  }

  private noteHostRemoteTurnAuthHealthy() {
    this.hostRemoteTurnUnauthenticatedFailures = 0;
  }

  private disposeHostConvexClient() {
    const client = this.hostConvexClient;
    this.hostConvexClient = null;
    this.hostConvexClientUrl = null;
    this.hostConvexClientAuthToken = null;
    if (client) {
      void client.close().catch(() => undefined);
    }
  }

  private ensureHostConvexClient(): ConvexClient | null {
    const deploymentUrl = this.getConfiguredHostConvexUrl();
    const authToken = this.getConfiguredHostAuthToken();
    if (!deploymentUrl) {
      this.disposeHostConvexClient();
      return null;
    }

    if (
      this.hostConvexClient &&
      this.hostConvexClientUrl === deploymentUrl &&
      this.hostConvexClientAuthToken === authToken
    ) {
      return this.hostConvexClient;
    }

    this.disposeHostConvexClient();
    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => this.getConfiguredHostAuthToken());
    this.hostConvexClient = client;
    this.hostConvexClientUrl = deploymentUrl;
    this.hostConvexClientAuthToken = authToken;
    return client;
  }

  private handleHostRemoteTurnAuthFailure(
    source: RemoteTurnAuthSource,
    error: unknown,
  ): { handled: boolean; stopped: boolean } {
    if (!isConvexUnauthenticatedError(error)) {
      return { handled: false, stopped: false };
    }

    this.hostRemoteTurnUnauthenticatedFailures += 1;
    if (
      !shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: this.hostRemoteTurnAuthWindowStartedAt,
        failureCount: this.hostRemoteTurnUnauthenticatedFailures,
        nowMs: Date.now(),
      })
    ) {
      return { handled: true, stopped: false };
    }

    this.stopHostHeartbeatLoop();
    this.stopHostRemoteTurnCancelSubscription();
    this.hostRemoteTurnBridge?.stop();
    this.hostDeviceRegistered = false;
    this.hostDeviceRegistering = false;
    this.hostRemoteTurnUnauthenticatedFailures = 0;
    console.warn(
      `[remote-turn] ${source} auth failed; stopping host remote turn sync until auth changes.`,
      error,
    );
    return { handled: true, stopped: true };
  }

  private async recoverHostRemoteTurnAuth(
    source: RemoteTurnAuthSource,
  ): Promise<boolean> {
    if (!this.options.hostHandlers.requestRuntimeAuthRefresh) {
      return false;
    }
    if (this.hostRemoteTurnAuthRecoveryPromise) {
      return await this.hostRemoteTurnAuthRecoveryPromise;
    }

    this.hostRemoteTurnAuthRecoveryPromise = (async () => {
      try {
        const result =
          await this.options.hostHandlers.requestRuntimeAuthRefresh?.({
            source,
          });
        const nextToken = result?.token?.trim() || null;
        const nextHasConnectedAccount = Boolean(result?.hasConnectedAccount);
        await this.configure({
          authToken: nextToken,
          hasConnectedAccount: nextHasConnectedAccount,
        });

        if (result?.authenticated && nextToken && nextHasConnectedAccount) {
          this.noteHostRemoteTurnAuthHealthy();
          console.info(
            `[remote-turn] Recovered host auth after ${source} failure.`,
          );
          return true;
        }

        console.warn(
          `[remote-turn] Host auth recovery did not restore a usable session after ${source} failure.`,
        );
        return false;
      } catch (refreshError) {
        console.warn(
          `[remote-turn] Failed to refresh host auth after ${source} failure:`,
          refreshError,
        );
        return false;
      } finally {
        this.hostRemoteTurnAuthRecoveryPromise = null;
      }
    })();

    return await this.hostRemoteTurnAuthRecoveryPromise;
  }

  private async markHostDeviceOffline(deviceId: string): Promise<void> {
    if (
      !this.getConfiguredHostAuthToken() ||
      !this.getConfiguredHostConvexUrl()
    ) {
      return;
    }
    const client = this.ensureHostConvexClient();
    if (!client) {
      return;
    }

    await (client as any).mutation(
      (
        anyApi as unknown as {
          agent: { device_resolver: { goOffline: unknown } };
        }
      ).agent.device_resolver.goOffline,
      { deviceId },
    );
  }

  private async recoverHostDeviceIdentityFromKeyMismatch(
    error: unknown,
  ): Promise<boolean> {
    const resetDeviceIdentity = this.options.hostHandlers.resetDeviceIdentity;
    if (!resetDeviceIdentity) {
      console.warn(
        "[remote-turn] Host device key mismatch cannot be recovered because identity reset is unavailable.",
        error,
      );
      return false;
    }
    if (this.hostDeviceIdentityRecoveryPromise) {
      return await this.hostDeviceIdentityRecoveryPromise;
    }

    this.hostDeviceIdentityRecoveryPromise = (async () => {
      const previousDeviceId = this.deviceIdentity?.deviceId ?? null;
      console.warn(
        "[remote-turn] Host device key mismatch; rotating local device identity.",
        error,
      );

      this.stopHostHeartbeatLoop();
      this.stopHostRemoteTurnCancelSubscription();
      this.hostRemoteTurnBridge?.stop();
      this.hostRemoteTurnBridge = null;
      this.hostDeviceRegistered = false;
      this.hostDeviceRegistering = false;

      if (previousDeviceId) {
        await this.markHostDeviceOffline(previousDeviceId).catch(
          () => undefined,
        );
      }

      this.deviceIdentity = await resetDeviceIdentity();
      this.workerHealthCache = null;
      this.ensureHostRemoteTurnBridge();
      this.ensureHostRemoteTurnCancelSubscription();
      const remoteTurnBridge = this.hostRemoteTurnBridge as ReturnType<
        typeof createRemoteTurnBridge
      > | null;
      remoteTurnBridge?.start();
      remoteTurnBridge?.kick();

      await this.registerHostDevice();
      this.startHostHeartbeatLoop();
      setTimeout(() => {
        void this.sendHostHeartbeat();
      }, 0);
      const activeRun = await this.getActiveRun().catch(() => null);
      if (!activeRun) {
        void this.scheduleRuntimeReload();
      }
      this.events.emit("runtime-ready", await this.health());
      return true;
    })();

    try {
      return await this.hostDeviceIdentityRecoveryPromise;
    } finally {
      this.hostDeviceIdentityRecoveryPromise = null;
    }
  }

  private async sendHostHeartbeat(retryOnAuthFailure = true): Promise<void> {
    if (this.hostDeviceIdentityRecoveryPromise) {
      return;
    }
    const authToken = this.getConfiguredHostAuthToken();
    if (!authToken || !this.configCache.hasConnectedAccount) {
      return;
    }
    const deviceId = this.deviceIdentity?.deviceId;
    if (!deviceId) {
      return;
    }
    const client = this.ensureHostConvexClient();
    if (!client) {
      return;
    }

    try {
      const signedAtMs = Date.now();
      const { publicKey, signature } =
        await this.options.hostHandlers.signHeartbeatPayload(signedAtMs);
      if (this.deviceIdentity?.deviceId !== deviceId) {
        return;
      }
      await (client as any).mutation(
        (
          anyApi as unknown as {
            agent: { device_resolver: { heartbeat: unknown } };
          }
        ).agent.device_resolver.heartbeat,
        {
          deviceId,
          deviceName: this.getHostDeviceName(),
          platform: process.platform,
          signedAtMs,
          signature,
          publicKey,
        },
      );
      this.hostDeviceRegistered = true;
      this.noteHostRemoteTurnAuthHealthy();
    } catch (error) {
      if (isConvexDeviceKeyMismatchError(error)) {
        await this.recoverHostDeviceIdentityFromKeyMismatch(error);
        return;
      }
      // A heartbeat can fire mid token-refresh with a stale/absent identity and
      // come back UNAUTHENTICATED even though the session is fine. Silently
      // refresh auth and retry once before treating it as a real auth failure,
      // so the transient race never surfaces or trips the failure-window
      // escalation below.
      if (retryOnAuthFailure && isConvexUnauthenticatedError(error)) {
        const recovered = await this.recoverHostRemoteTurnAuth("heartbeat");
        if (recovered) {
          await this.sendHostHeartbeat(false);
          return;
        }
        // Refresh could not restore a usable session — fall through to the
        // normal failure accounting/escalation.
      }
      const authFailure = this.handleHostRemoteTurnAuthFailure(
        "heartbeat",
        error,
      );
      if (authFailure.stopped) {
        void this.recoverHostRemoteTurnAuth("heartbeat");
        return;
      }
      if (authFailure.handled) {
        return;
      }
      console.warn("[remote-turn] Host heartbeat failed:", error);
    }
  }

  private startHostHeartbeatLoop() {
    if (this.hostHeartbeatTimer) {
      return;
    }
    this.hostHeartbeatTimer = setInterval(() => {
      void this.sendHostHeartbeat();
    }, DEVICE_HEARTBEAT_INTERVAL_MS);
  }

  private async registerHostDevice(attempt = 0): Promise<void> {
    if (this.hostDeviceRegistered || this.hostDeviceRegistering) {
      return;
    }
    const authToken = this.getConfiguredHostAuthToken();
    if (!authToken || !this.configCache.hasConnectedAccount) {
      return;
    }
    const deviceId = this.deviceIdentity?.deviceId;
    if (!deviceId) {
      return;
    }
    const client = this.ensureHostConvexClient();
    if (!client) {
      return;
    }

    this.hostDeviceRegistering = true;
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    if (this.deviceIdentity?.deviceId !== deviceId) {
      this.hostDeviceRegistering = false;
      return;
    }
    if (this.hostDeviceRegistered) {
      this.hostDeviceRegistering = false;
      return;
    }

    try {
      await (client as any).mutation(
        (
          anyApi as unknown as {
            agent: { device_resolver: { registerDevice: unknown } };
          }
        ).agent.device_resolver.registerDevice,
        {
          deviceId,
          deviceName: this.getHostDeviceName(),
          platform: process.platform,
        },
      );
      if (this.deviceIdentity?.deviceId === deviceId) {
        this.hostDeviceRegistered = true;
        this.noteHostRemoteTurnAuthHealthy();
      }
    } catch (error) {
      const authFailure = this.handleHostRemoteTurnAuthFailure(
        "register",
        error,
      );
      if (authFailure.stopped) {
        void this.recoverHostRemoteTurnAuth("register");
        this.hostDeviceRegistering = false;
        return;
      }
      if (authFailure.handled) {
        this.hostDeviceRegistering = false;
        return;
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        this.hostDeviceRegistering = false;
        return await this.registerHostDevice(attempt + 1);
      }
    }
    this.hostDeviceRegistering = false;
  }

  private async sendHostGoOffline() {
    this.stopHostHeartbeatLoop();
    if (!this.hostDeviceRegistered) {
      return;
    }
    if (
      !this.getConfiguredHostAuthToken() ||
      !this.getConfiguredHostConvexUrl()
    ) {
      this.hostDeviceRegistered = false;
      return;
    }
    const deviceId = this.deviceIdentity?.deviceId;
    if (!deviceId) {
      this.hostDeviceRegistered = false;
      return;
    }

    try {
      await this.markHostDeviceOffline(deviceId);
      this.hostDeviceRegistered = false;
    } catch {
      // best-effort
    }
  }

  private ensureHostRemoteTurnBridge() {
    if (this.hostRemoteTurnBridge || !this.deviceIdentity?.deviceId) {
      return;
    }

    this.hostRemoteTurnBridge = createRemoteTurnBridge({
      deviceId: this.deviceIdentity.deviceId,
      isEnabled: () => this.started && this.hostReady,
      isRunnerBusy: () => false,
      subscribeRemoteTurnRequests: ({
        deviceId: targetDeviceId,
        since,
        onUpdate,
        onError,
      }) => {
        const client = this.ensureHostConvexClient();
        if (!client) {
          return () => {};
        }

        const subscription = (client as any).onUpdate(
          (
            anyApi as {
              events: { subscribeRemoteTurnRequestsForDevice: unknown };
            }
          ).events.subscribeRemoteTurnRequestsForDevice,
          {
            deviceId: targetDeviceId,
            since,
            limit: 20,
          },
          (events: unknown) => {
            this.noteHostRemoteTurnAuthHealthy();
            onUpdate(
              events as Array<{
                _id: string;
                timestamp: number;
                type: string;
                requestId?: string;
                payload?: Record<string, unknown>;
              }>,
            );
          },
          (error: Error) => {
            const authFailure = this.handleHostRemoteTurnAuthFailure(
              "subscription",
              error,
            );
            if (authFailure.stopped) {
              void this.recoverHostRemoteTurnAuth("subscription");
              return;
            }
            if (authFailure.handled) {
              return;
            }
            onError?.(error);
          },
        );

        return () => {
          subscription.unsubscribe();
        };
      },
      runLocalTurn: async ({
        requestId,
        conversationId,
        userPrompt,
        agentType,
        modelOverride,
        provider,
        externalMessageId,
        attachments,
      }) => {
        const localConversationId = this.configCache.cloudSyncEnabled
          ? conversationId || (await this.getOrCreateDefaultConversationId())
          : await this.getActiveLocalConversationId();
        // Arm follow-up routing before the orchestrator turn runs so any
        // assistant message the worker persists during this run already
        // routes back to the connector. The map entry is cleared by the
        // local-chat listener as soon as the user sends a non-connector
        // message in this conversation.
        this.connectorTargetsByLocalConversation.set(localConversationId, {
          requestId,
          backendConversationId: conversationId,
          initialTurnCompleted: false,
          pendingFollowupTexts: [],
        });
        this.localConversationByRequestId.set(requestId, localConversationId);
        this.armConnectorStreamBuffer({
          requestId,
          backendConversationId: conversationId,
          provider,
        });
        await this.appendLocalChatEvent({
          conversationId: localConversationId,
          type: "user_message",
          payload: {
            text: userPrompt,
            source: "connector",
            ...(provider ? { provider } : {}),
            ...(provider === "linq" && externalMessageId
              ? { linqMessageId: externalMessageId }
              : {}),
            ...(attachments?.length ? { attachments } : {}),
          },
        });
        const isLinqTurn = provider === "linq";
        if (isLinqTurn) {
          await this.executeLinqConnectorLifecycleOperation({
            requestId,
            conversationId,
            operation: "read",
            payload: {},
          });
          await this.executeLinqConnectorLifecycleOperation({
            requestId,
            conversationId,
            operation: "typing",
            payload: { action: "start" },
          });
        }
        try {
          const result = await this.requestWorker<RuntimeAutomationTurnResult>(
            METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
            {
              conversationId: localConversationId,
              userPrompt,
              ...(agentType ? { agentType } : {}),
              ...(modelOverride ? { modelOverride } : {}),
              ...(attachments?.length ? { attachments } : {}),
              connectorDeliveryTarget: {
                requestId,
                conversationId,
                ...(provider ? { provider } : {}),
                ...(externalMessageId ? { externalMessageId } : {}),
              },
            },
            {
              ensureWorker: true,
              recordActivity: true,
              retryOnceOnDisconnect: true,
            },
          );
          if (result.status === "ok" && result.finalText) {
            await this.appendLocalChatEvent({
              conversationId: localConversationId,
              type: "assistant_message",
              payload: { text: result.finalText, source: "connector" },
            });
          }
          if (result.status !== "ok") {
            this.clearConnectorStreamBuffer(requestId);
          }
          return result;
        } catch (error) {
          this.clearConnectorStreamBuffer(requestId);
          throw error;
        } finally {
          if (isLinqTurn) {
            await this.executeLinqConnectorLifecycleOperation({
              requestId,
              conversationId,
              operation: "typing",
              payload: { action: "stop" },
            });
          }
        }
      },
      claimRemoteTurn: async ({ requestId, conversationId }) => {
        const client = this.ensureHostConvexClient();
        if (!client) {
          return;
        }
        await (client as any).mutation(
          (
            anyApi as unknown as {
              channels: { connector_delivery: { claimRemoteTurn: unknown } };
            }
          ).channels.connector_delivery.claimRemoteTurn,
          { requestId, conversationId },
        );
      },
      completeConnectorTurn: async ({ requestId, conversationId, text }) => {
        const client = this.ensureHostConvexClient();
        if (!client) {
          throw new Error("Missing Convex client configuration.");
        }
        await (client as any).mutation(
          (
            anyApi as unknown as {
              channels: { connector_delivery: { completeRemoteTurn: unknown } };
            }
          ).channels.connector_delivery.completeRemoteTurn,
          { requestId, conversationId, text },
        );
        this.markConnectorInitialTurnCompleted({
          requestId,
          backendConversationId: conversationId,
        });
        this.clearConnectorStreamBuffer(requestId);
      },
      log: (level, message, error) => {
        const logger = level === "error" ? console.error : console.warn;
        if (error === undefined) {
          logger(message);
          return;
        }
        logger(message, error);
      },
    });
  }

  private async executeLinqConnectorLifecycleOperation(args: {
    requestId: string;
    conversationId: string;
    operation: "read" | "typing";
    payload: Record<string, unknown>;
  }): Promise<void> {
    const client = this.ensureHostConvexClient();
    if (!client) {
      return;
    }
    try {
      await (client as any).action(
        (
          anyApi as unknown as {
            channels: { linq: { executeLinqConnectorTool: unknown } };
          }
        ).channels.linq.executeLinqConnectorTool,
        {
          requestId: args.requestId,
          conversationId: args.conversationId,
          operation: args.operation,
          payload: args.payload,
        },
      );
    } catch (error) {
      console.warn(
        `[runtime-host] Linq ${args.operation} lifecycle operation failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async sendConnectorFollowup(args: {
    requestId: string;
    backendConversationId: string;
    text: string;
  }): Promise<void> {
    const client = this.ensureHostConvexClient();
    if (!client) {
      return;
    }
    try {
      await (client as any).mutation(
        (
          anyApi as unknown as {
            channels: {
              connector_delivery: { sendConnectorFollowup: unknown };
            };
          }
        ).channels.connector_delivery.sendConnectorFollowup,
        {
          requestId: args.requestId,
          conversationId: args.backendConversationId,
          text: args.text,
        },
      );
    } catch (error) {
      console.warn(
        "[runtime-host] sendConnectorFollowup failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private armConnectorStreamBuffer(args: {
    requestId: string;
    backendConversationId: string;
    provider?: string;
  }): void {
    if (args.provider !== "telegram") {
      return;
    }
    const existing = this.connectorStreamBuffersByRequestId.get(args.requestId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.connectorStreamBuffersByRequestId.set(args.requestId, {
      requestId: args.requestId,
      backendConversationId: args.backendConversationId,
      provider: args.provider,
      text: "",
      revision: 0,
      lastSentRevision: 0,
      lastSentTextLength: 0,
      lastSentAt: 0,
      timer: null,
      inFlight: null,
    });
  }

  private clearConnectorStreamBuffer(requestId: string): void {
    const buffer = this.connectorStreamBuffersByRequestId.get(requestId);
    if (buffer?.timer) {
      clearTimeout(buffer.timer);
    }
    this.connectorStreamBuffersByRequestId.delete(requestId);
  }

  private clearAllConnectorStreamBuffers(): void {
    for (const buffer of this.connectorStreamBuffersByRequestId.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
    }
    this.connectorStreamBuffersByRequestId.clear();
  }

  private handleConnectorStreamRunEvent(event: RuntimeAgentEventPayload): void {
    if (
      event.type !== AGENT_STREAM_EVENT_TYPES.STREAM ||
      !event.requestId ||
      !event.chunk
    ) {
      return;
    }
    const buffer = this.connectorStreamBuffersByRequestId.get(event.requestId);
    if (!buffer || buffer.provider !== "telegram") {
      return;
    }
    buffer.text += event.chunk;
    buffer.revision += 1;
    this.scheduleConnectorStreamFlush(buffer);
  }

  private scheduleConnectorStreamFlush(buffer: ConnectorStreamBuffer): void {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    const pendingChars = Math.max(
      0,
      buffer.text.length - buffer.lastSentTextLength,
    );
    const elapsed = Date.now() - buffer.lastSentAt;
    if (
      pendingChars >= CONNECTOR_STREAM_BUFFER_THRESHOLD ||
      elapsed >= CONNECTOR_STREAM_FLUSH_INTERVAL_MS
    ) {
      void this.flushConnectorStreamBuffer(buffer);
      return;
    }
    buffer.timer = setTimeout(
      () => {
        buffer.timer = null;
        void this.flushConnectorStreamBuffer(buffer);
      },
      Math.max(0, CONNECTOR_STREAM_FLUSH_INTERVAL_MS - elapsed),
    );
    buffer.timer.unref?.();
  }

  private async flushConnectorStreamBuffer(
    buffer: ConnectorStreamBuffer,
  ): Promise<void> {
    if (buffer.inFlight) {
      await buffer.inFlight.catch(() => undefined);
    }
    const client = this.ensureHostConvexClient();
    const text = buffer.text.trim();
    if (
      !client ||
      !text ||
      buffer.revision <= buffer.lastSentRevision ||
      !this.connectorStreamBuffersByRequestId.has(buffer.requestId)
    ) {
      return;
    }
    const revision = buffer.revision;
    buffer.inFlight = (async () => {
      try {
        await (client as any).mutation(
          (
            anyApi as unknown as {
              channels: {
                connector_delivery: { streamConnectorTurnUpdate: unknown };
              };
            }
          ).channels.connector_delivery.streamConnectorTurnUpdate,
          {
            requestId: buffer.requestId,
            conversationId: buffer.backendConversationId,
            text,
            revision,
          },
        );
        buffer.lastSentRevision = Math.max(buffer.lastSentRevision, revision);
        buffer.lastSentTextLength = Math.max(
          buffer.lastSentTextLength,
          text.length,
        );
        buffer.lastSentAt = Date.now();
      } catch (error) {
        console.warn(
          "[runtime-host] streamConnectorTurnUpdate failed:",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        buffer.inFlight = null;
        if (
          this.connectorStreamBuffersByRequestId.has(buffer.requestId) &&
          buffer.revision > buffer.lastSentRevision
        ) {
          this.scheduleConnectorStreamFlush(buffer);
        }
      }
    })();
    await buffer.inFlight;
  }

  private markConnectorInitialTurnCompleted(args: {
    requestId: string;
    backendConversationId: string;
  }): void {
    const localConversationId = this.localConversationByRequestId.get(
      args.requestId,
    );
    if (!localConversationId) {
      return;
    }
    const target =
      this.connectorTargetsByLocalConversation.get(localConversationId);
    if (
      !target ||
      target.requestId !== args.requestId ||
      target.backendConversationId !== args.backendConversationId
    ) {
      return;
    }
    target.initialTurnCompleted = true;
    const pendingTexts = target.pendingFollowupTexts.splice(0);
    for (const text of pendingTexts) {
      void this.sendConnectorFollowup({
        requestId: target.requestId,
        backendConversationId: target.backendConversationId,
        text,
      });
    }
  }

  private queueOrSendConnectorFollowup(args: {
    target: ConnectorFollowupTarget;
    text: string;
  }): void {
    if (!args.target.initialTurnCompleted) {
      args.target.pendingFollowupTexts.push(args.text);
      return;
    }
    void this.sendConnectorFollowup({
      requestId: args.target.requestId,
      backendConversationId: args.target.backendConversationId,
      text: args.text,
    });
  }

  private handleLocalChatUpdateForConnectorFollowup(
    payload: LocalChatUpdatedPayload | null,
  ): void {
    if (!payload) return;
    const conversationId = payload.conversationId;
    if (!conversationId || !payload.event) return;

    const target = this.connectorTargetsByLocalConversation.get(conversationId);
    if (!target) return;

    const action = resolveConnectorFollowupAction(payload);
    switch (action.type) {
      case "clear-target": {
        // The desktop user typed in this conversation — switch routing back
        // to the desktop. Connector-sourced user messages (the ones armed
        // by `runLocalTurn` above) keep the target alive.
        const cleared =
          this.connectorTargetsByLocalConversation.get(conversationId);
        this.connectorTargetsByLocalConversation.delete(conversationId);
        if (cleared) {
          this.localConversationByRequestId.delete(cleared.requestId);
        }
        return;
      }
      case "send":
        this.queueOrSendConnectorFollowup({
          target,
          text: action.text,
        });
        return;
      case "ignore":
        return;
    }
  }

  private syncHostRemoteTurnBridge() {
    if (!this.started || !this.hostReady) {
      this.stopHostHeartbeatLoop();
      this.stopHostRemoteTurnCancelSubscription();
      this.hostRemoteTurnBridge?.stop();
      this.clearAllConnectorStreamBuffers();
      void this.sendHostGoOffline().finally(() => {
        this.disposeHostConvexClient();
      });
      return;
    }

    const authToken = this.getConfiguredHostAuthToken();
    const convexUrl = this.getConfiguredHostConvexUrl();
    if (!authToken || !convexUrl) {
      this.stopHostHeartbeatLoop();
      this.stopHostRemoteTurnCancelSubscription();
      this.hostRemoteTurnBridge?.stop();
      this.clearAllConnectorStreamBuffers();
      this.hostDeviceRegistered = false;
      this.hostDeviceRegistering = false;
      this.disposeHostConvexClient();
      return;
    }
    if (!this.configCache.hasConnectedAccount) {
      this.stopHostHeartbeatLoop();
      this.stopHostRemoteTurnCancelSubscription();
      this.hostRemoteTurnBridge?.stop();
      this.clearAllConnectorStreamBuffers();
      void this.sendHostGoOffline().finally(() => {
        this.disposeHostConvexClient();
      });
      return;
    }

    this.ensureHostRemoteTurnBridge();
    if (!this.hostRemoteTurnBridge) {
      return;
    }

    this.resetHostRemoteTurnAuthTracking();
    void this.registerHostDevice();
    this.startHostHeartbeatLoop();
    void this.sendHostHeartbeat();
    this.hostRemoteTurnBridge.start();
    this.hostRemoteTurnBridge.kick();
    this.ensureHostRemoteTurnCancelSubscription();
  }

  /**
   * Subscribes to `events.subscribeRemoteTurnCancelsForDevice` so a phone
   * (or any other client) that calls `mobile_chat.cancelChat` /
   * `cancelRemoteTurn` can abort the in-flight orchestrator run on this
   * desktop. The request feed alone is not enough — once the request is
   * `claimed`, it drops out of `subscribeRemoteTurnRequestsForDevice`'s
   * `pending`-only filter, so the active run is invisible to the request
   * stream. The cancel feed is a dedicated channel for "abort a run you
   * already started".
   *
   * Cancellation of a not-yet-claimed request is handled implicitly by
   * the request feed (cancelled rows fall out of the snapshot and the
   * bridge garbage-collects its pending entry) — this subscription only
   * acts on cancels for active local conversations.
   */
  private ensureHostRemoteTurnCancelSubscription() {
    if (this.hostRemoteTurnCancelUnsubscribe) return;
    const deviceId = this.deviceIdentity?.deviceId;
    if (!deviceId) return;
    const client = this.ensureHostConvexClient();
    if (!client) return;

    const subscription = (client as any).onUpdate(
      (
        anyApi as {
          events: { subscribeRemoteTurnCancelsForDevice: unknown };
        }
      ).events.subscribeRemoteTurnCancelsForDevice,
      {
        deviceId,
        since: Date.now() - 5 * 60_000,
        limit: 50,
      },
      (rows: unknown) => {
        if (!Array.isArray(rows)) return;
        for (const row of rows as Array<{
          requestId?: string;
          conversationId?: string;
        }>) {
          const requestId =
            typeof row?.requestId === "string" ? row.requestId : "";
          if (!requestId || this.cancelledRequestIds.has(requestId)) continue;
          this.cancelledRequestIds.add(requestId);
          const localConversationId =
            this.localConversationByRequestId.get(requestId);
          if (!localConversationId) continue;
          void this.cancelChatByConversation(localConversationId).catch(
            (error: unknown) => {
              console.warn(
                "[runtime-host] cancelChatByConversation failed:",
                error instanceof Error ? error.message : String(error),
              );
            },
          );
        }
      },
      (error: Error) => {
        console.warn(
          "[runtime-host] Remote turn cancel subscription failed:",
          error.message,
        );
      },
    );

    this.hostRemoteTurnCancelUnsubscribe = () => {
      subscription.unsubscribe();
    };
  }

  private stopHostRemoteTurnCancelSubscription() {
    if (!this.hostRemoteTurnCancelUnsubscribe) return;
    try {
      this.hostRemoteTurnCancelUnsubscribe();
    } catch {
      // best-effort teardown
    }
    this.hostRemoteTurnCancelUnsubscribe = null;
  }

  on<K extends keyof RuntimeHostEvents>(
    eventName: K,
    listener: (payload: RuntimeHostEvents[K]) => void,
  ): () => void {
    this.events.on(eventName, listener as (...args: unknown[]) => void);
    return () => {
      this.events.removeListener(
        eventName,
        listener as (...args: unknown[]) => void,
      );
    };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.persistRuntimeReloadPauseState();
    await this.initializeHostServices();
    this.syncHostRemoteTurnBridge();
    this.events.emit("runtime-connected", undefined);
    this.events.emit("runtime-ready", await this.health());
    this.startDevWatcher(resolveDefaultWorkerEntryPath(this.options));
  }

  async stop(options?: { killWorker?: boolean }) {
    // Restart-with-continuation: persist the shutdown record FIRST and
    // synchronously — every graceful teardown (app quit, dev-supervisor
    // SIGTERM, self-mod process-restart relaunch) funnels through here and
    // may not survive the rest of this method. A pending self-mod restart
    // reason wins over the generic app-shutdown label; an existing record
    // written moments ago by a more specific path is preserved.
    this.writeRestartContinuationRecord(
      this.pendingStaleWorkerRestart?.reason ?? "app-shutdown",
      { skipIfPresent: true },
    );
    this.started = false;
    this.hostReady = false;
    this.workerHealthCache = null;
    this.workerGeneration = 0;
    this.agentEventBuffers.clear();
    this.pendingRunEventAcks.clear();
    this.clearAllConnectorStreamBuffers();
    if (this.runEventAckTimer) clearTimeout(this.runEventAckTimer);
    this.runEventAckTimer = null;
    this.pausedRuntimeReloadRuns.clear();
    this.stopPausedRuntimeReloadSweep();
    this.deferredRuntimeReload = false;
    this.restartInProgress = false;
    this.restartRequestedDuringRestart = false;
    // The on-disk pending-restart flag intentionally survives host stop so
    // the next host's reconnect handshake picks the deferral back up.
    this.pendingStaleWorkerRestart = null;
    this.stopStaleWorkerQuiescencePoll();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.persistRuntimeReloadPauseState().catch(() => undefined);
    await this.workerController.stop(
      options?.killWorker ? "restart" : "stopped",
    );
    await this.stopHostServices();
    this.deviceIdentity = null;
    this.configCache = {};
    this.events.emit("runtime-disconnected", { reason: "stopped" });
  }

  async configure(params: RuntimeConfigureParams) {
    this.configCache = { ...this.configCache, ...params };
    this.syncHostRemoteTurnBridge();
    const connection = this.workerController.getConnection();
    if (!connection?.peer) {
      return { ok: true };
    }
    return await connection.peer.request(
      METHOD_NAMES.INTERNAL_WORKER_CONFIGURE,
      params,
    );
  }

  async health(): Promise<RuntimeHealthSnapshot> {
    return await this.buildHealthSnapshot();
  }

  async restartWorker() {
    const startedAt = Date.now();
    this.events.emit("runtime-reloading", { reason: "worker-restart" });
    await this.workerController.stop("restart");
    // The restart killed the worker, and every self-mod run it was tracking
    // died with it. Any runtime-reload pauses those runs held would never be
    // resumed (the resume RPC comes from the worker-side run lifecycle), so
    // clear them here instead of leaking a permanent reload deferral.
    if (this.pausedRuntimeReloadRuns.size > 0) {
      getFileLogger()?.warn("host.runtime-reload-pauses-cleared-on-restart", {
        count: this.pausedRuntimeReloadRuns.size,
      });
      this.pausedRuntimeReloadRuns.clear();
      this.stopPausedRuntimeReloadSweep();
      this.deferredRuntimeReload = false;
      await this.persistRuntimeReloadPauseState().catch(() => undefined);
    }
    const stoppedAt = Date.now();
    await this.workerController.ensureStarted();
    const readyAt = Date.now();
    // Restart-latency breakdown: stopMs (drain + kill grace) vs startMs (spawn
    // + cold parse + ready probe + init handshake). Pairs with the worker-side
    // `worker.kill-latency` and `startup.post-ready-complete` lines.
    getFileLogger()?.process("host.worker-restart-latency", {
      stopMs: stoppedAt - startedAt,
      startMs: readyAt - stoppedAt,
      totalMs: readyAt - startedAt,
      generation: this.workerGeneration,
    });
    return { ok: true };
  }

  /**
   * Proactively spawn the worker process without forcing a model-catalog
   * fetch. The worker self-warms its catalog on init/configure (debounced),
   * so this is just the process spin-up — kept off the open burst by the
   * caller (deferred-startup) so it doesn't contend with first paint.
   */
  async ensureWorkerStarted() {
    await this.workerController.ensureStarted();
    return { ok: true };
  }

  async healthCheck() {
    const health = await this.getWorkerHealth({ ensureWorker: false });
    return health?.health ?? null;
  }

  async getActiveRun() {
    const health = await this.getWorkerHealth({ ensureWorker: false });
    return health?.activeRun ?? null;
  }

  async listActiveRuns() {
    try {
      return await this.requestWorker<{
        runs: Array<{
          runId: string;
          conversationId: string;
          kind: "active" | "buffered";
          uiVisibility?: "visible" | "hidden";
        }>;
      }>(
        METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS,
        {},
        { ensureWorker: false, recordActivity: false },
      );
    } catch {
      return { runs: [] };
    }
  }

  async listModels(
    request: RuntimeListModelsRequest = {},
  ): Promise<RuntimeModelCatalogSnapshot> {
    return await this.requestWorker<RuntimeModelCatalogSnapshot>(
      METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS,
      request,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async startChat(payload: RuntimeChatPayload) {
    return await this.requestWorker<{ runId: string; userMessageId: string }>(
      METHOD_NAMES.INTERNAL_WORKER_START_CHAT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async sendAgentInput(payload: {
    conversationId: string;
    threadId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    return await this.requestWorker<{ delivered: boolean }>(
      METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async cancelChat(runId: string) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_CANCEL,
      { runId },
      { ensureWorker: false, recordActivity: true },
    );
  }

  async cancelChatByConversation(conversationId: string) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION,
      { conversationId },
      { ensureWorker: false, recordActivity: true },
    );
  }

  async resumeRunEvents(payload: {
    runId: string;
    lastSeq: number;
  }): Promise<RunResumeEventsResult> {
    pruneAgentEventBuffers(this.agentEventBuffers);
    // Fast path: host-side in-memory buffer covers the renderer-reload
    // case (renderer reloads but host process is still alive). Falls
    // through to the worker for the host-restart case where the buffer
    // is gone but the worker still has the persistent event log.
    const buffer = this.agentEventBuffers.get(payload.runId);
    if (buffer) {
      const oldestSeq = buffer.events[0]?.seq ?? null;
      const events = buffer.events.filter(
        (event) => event.seq > payload.lastSeq,
      );
      const exhausted = oldestSeq !== null && payload.lastSeq < oldestSeq - 1;
      if (events.length > 0 || !exhausted) {
        return { events, exhausted };
      }
    }

    // Worker fallback. We only call this when the in-memory buffer
    // missed — keeps the cost off the hot path during normal streaming.
    try {
      const remote = await this.requestWorker<RunResumeEventsResult>(
        METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS,
        { runId: payload.runId, lastSeq: payload.lastSeq },
        { ensureWorker: false, recordActivity: false },
      );
      return remote;
    } catch {
      return { events: [], exhausted: true };
    }
  }

  /**
   * Ack an event the host has successfully forwarded to the renderer.
   * Best-effort and async-fire-and-forget — a missed ack just keeps
   * the row in the worker's ring buffer a little longer; the periodic
   * sweep eventually drops aged entries regardless.
   */
  private flushRunEventAcks() {
    if (this.runEventAckTimer) {
      clearTimeout(this.runEventAckTimer);
      this.runEventAckTimer = null;
    }
    const pending = this.pendingRunEventAcks;
    if (pending.size === 0) return;
    this.pendingRunEventAcks = new Map();
    for (const [runId, lastSeq] of pending) {
      void this.requestWorker(
        METHOD_NAMES.INTERNAL_WORKER_ACK_EVENTS,
        { runId, lastSeq },
        { ensureWorker: false, recordActivity: false },
      ).catch(() => undefined);
    }
  }

  private scheduleRunEventAck(runId: string, lastSeq: number) {
    if (!runId || !Number.isFinite(lastSeq)) return;
    const previous = this.pendingRunEventAcks.get(runId) ?? 0;
    this.pendingRunEventAcks.set(runId, Math.max(previous, lastSeq));
    if (this.runEventAckTimer) return;
    this.runEventAckTimer = setTimeout(() => {
      this.flushRunEventAcks();
    }, 150);
    this.runEventAckTimer.unref?.();
  }

  async runAutomationTurn(payload: RuntimeAutomationTurnRequest) {
    return await this.requestWorker<RuntimeAutomationTurnResult>(
      METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async runBlockingLocalAgent(payload: RuntimeLocalAgentRequest) {
    return await this.requestWorker<
      | { status: "ok"; finalText: string; agentId: string }
      | { status: "error"; finalText: ""; error: string; agentId?: string }
    >(METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT, payload, {
      ensureWorker: true,
      recordActivity: true,
    });
  }

  async createBackgroundAgent(payload: RuntimeLocalAgentRequest) {
    return await this.requestWorker<{ agentId: string }>(
      METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async getLocalAgentSnapshot(agentId: string) {
    return await this.requestWorker<RuntimeLocalAgentSnapshot | null>(
      METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT,
      { agentId },
      { ensureWorker: false, recordActivity: false },
    );
  }

  async appendThreadMessage(args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE,
      args,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async webSearch(query: string, options?: { category?: string }) {
    return await this.requestWorker<RuntimeWebSearchResult>(
      METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH,
      { query, ...options },
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async runOneShotCompletion(payload: RuntimeOneShotCompletionRequest) {
    return await this.requestWorker<RuntimeOneShotCompletionResult>(
      METHOD_NAMES.INTERNAL_WORKER_ONE_SHOT_COMPLETION,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async persistVoiceTranscript(payload: RuntimeVoiceTranscriptPayload) {
    return await this.requestWorker<{ ok: true }>(
      METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async voiceOrchestratorChat(payload: RuntimeVoiceChatPayload) {
    return await this.requestWorker<string>(
      METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async voiceOrchestratorConfig(
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ) {
    return await this.requestWorker<RuntimeVoiceOrchestratorConfig>(
      METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async voiceExecuteTool(payload: RuntimeVoiceToolCallPayload) {
    return await this.requestWorker<RuntimeVoiceToolCallResult>(
      METHOD_NAMES.INTERNAL_WORKER_VOICE_EXECUTE_TOOL,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async voiceWebSearch(payload: { query: string; category?: string }) {
    return await this.requestWorker<RuntimeWebSearchResult>(
      METHOD_NAMES.INTERNAL_WORKER_VOICE_WEB_SEARCH,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async getOrCreateDefaultConversationId() {
    return await this.requestWorker<string>(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
      undefined,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async listLocalChatEvents(payload: {
    conversationId: string;
    maxItems?: number;
  }) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS,
      payload,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async getLocalChatEventCount(payload: { conversationId: string }) {
    return await this.requestWorker<number>(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT,
      payload,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async persistDiscoveryWelcome(payload: {
    conversationId: string;
    message: string;
    firstReport?: unknown;
  }) {
    return await this.requestWorker<{ ok: true }>(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async listLocalChatSyncMessages(payload: {
    conversationId: string;
    maxMessages?: number;
  }) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES,
      payload,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async getLocalChatSyncCheckpoint(payload: { conversationId: string }) {
    return await this.requestWorker<string | null>(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT,
      payload,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async setLocalChatSyncCheckpoint(payload: {
    conversationId: string;
    localMessageId: string;
  }) {
    return await this.requestWorker<{ ok: true }>(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT,
      payload,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async listInstalledMods() {
    return await this.requestWorker<StoreInstallRecord[]>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED,
      undefined,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async readSelfModFeatureSnapshot() {
    return await this.requestWorker<SelfModFeatureSnapshot | null>(
      METHOD_NAMES.INTERNAL_WORKER_FEATURE_SNAPSHOT_READ,
      undefined,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async listSelfModFeatureRoster(payload?: {
    limit?: number;
    offset?: number;
  }) {
    return await this.requestWorker<SelfModFeatureRosterPage>(
      METHOD_NAMES.INTERNAL_WORKER_FEATURE_ROSTER_LIST,
      payload,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async beginExternalSelfMod(payload: { runId: string; paths: string[] }) {
    return await this.requestWorker<{ ok: true }>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_EXTERNAL_BEGIN,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async finishExternalSelfMod(payload: { runId: string; succeeded: boolean }) {
    return await this.requestWorker<{ ok: true; transitioned: boolean }>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_EXTERNAL_FINISH,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async recordSourcePackHistory(payload: {
    sourcePack: StoreReleaseSourcePack;
    origin?:
      | "self-mod"
      | "store-install"
      | "store-update"
      | "store-uninstall"
      | "desktop-update"
      | "official";
    packageId?: string;
    releaseNumber?: number;
    featureId?: string;
    description?: string;
    commitHash?: string | null;
  }) {
    return await this.requestWorker<{ ok: true }>(
      METHOD_NAMES.INTERNAL_WORKER_SOURCE_PACK_HISTORY_RECORD,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async hasSourceRevisionForCommit(commitHash: string) {
    return await this.requestWorker<{
      ok: true;
      exists: boolean;
      revisionId: string | null;
    }>(
      METHOD_NAMES.INTERNAL_WORKER_SOURCE_HISTORY_HAS_COMMIT,
      { commitHash },
      { ensureWorker: true, recordActivity: true },
    );
  }

  async listStorePackages() {
    return await this.requestWorker<StorePackageRecord[]>(
      METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES,
      undefined,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async getStorePackage(packageId: string) {
    return await this.requestWorker<StorePackageRecord | null>(
      METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE,
      { packageId },
      { ensureWorker: true, recordActivity: true },
    );
  }

  async listStorePackageReleases(packageId: string) {
    return await this.requestWorker<StorePackageReleaseRecord[]>(
      METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES,
      { packageId },
      { ensureWorker: true, recordActivity: true },
    );
  }

  async getStorePackageRelease(packageId: string, releaseNumber: number) {
    return await this.requestWorker<StorePackageReleaseRecord | null>(
      METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE,
      { packageId, releaseNumber },
      { ensureWorker: true, recordActivity: true },
    );
  }

  async createFirstStoreRelease(args: StorePublishArgs) {
    return await this.requestWorker<StorePackageReleaseRecord>(
      METHOD_NAMES.INTERNAL_WORKER_CREATE_FIRST_STORE_RELEASE,
      args,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async createStoreReleaseUpdate(args: StorePublishArgs) {
    return await this.requestWorker<StorePackageReleaseRecord>(
      METHOD_NAMES.INTERNAL_WORKER_CREATE_STORE_RELEASE_UPDATE,
      args,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async publishStoreSelectedFeatures(args: StorePublishSelectedFeaturesArgs) {
    return await this.requestWorker<StorePackageReleaseRecord>(
      METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_SELECTED_FEATURES,
      args,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async uninstallStoreMod(packageId: string) {
    return await this.requestWorker<{
      packageId: string;
      revertedCommits: string[];
    }>(
      METHOD_NAMES.INTERNAL_WORKER_UNINSTALL_STORE_MOD,
      { packageId },
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async installFromBlueprint(payload: {
    packageId: string;
    releaseNumber: number;
    displayName: string;
    blueprintMarkdown: string;
    gitArtifact?: StoreReleaseGitArtifact;
    diff?: string;
    commits?: Array<{ hash: string; subject: string; diff: string }>;
  }) {
    return await this.requestWorker<StoreInstallRecord>(
      METHOD_NAMES.INTERNAL_WORKER_INSTALL_FROM_BLUEPRINT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async listCronJobs(): Promise<LocalCronJobRecord[]> {
    return this.ensureScheduler().listCronJobs();
  }

  async listHeartbeats(): Promise<LocalHeartbeatConfigRecord[]> {
    return this.ensureScheduler().listHeartbeats();
  }

  /**
   * Direct mutation surface used by the renderer-side schedule chip / dialog
   * (Run now, Pause/Resume, Delete). Same in-process scheduler the
   * Schedule subagent talks to via tools — both paths converge on
   * `LocalSchedulerService` and emit the shared `schedule.updated`
   * notification on success, so the chat surface and the Up next list
   * refresh together.
   */
  async runCronJob(jobId: string): Promise<LocalCronJobRecord | null> {
    return this.ensureScheduler().runCronJob(jobId);
  }

  async removeCronJob(jobId: string): Promise<boolean> {
    return this.ensureScheduler().removeCronJob(jobId);
  }

  async updateCronJob(
    jobId: string,
    patch: LocalCronJobUpdatePatch,
  ): Promise<LocalCronJobRecord | null> {
    return this.ensureScheduler().updateCronJob(jobId, patch);
  }

  async upsertHeartbeat(
    input: LocalHeartbeatUpsertInput,
  ): Promise<LocalHeartbeatConfigRecord> {
    return this.ensureScheduler().upsertHeartbeat(input);
  }

  async runHeartbeat(
    conversationId: string,
  ): Promise<LocalHeartbeatConfigRecord | null> {
    return this.ensureScheduler().runHeartbeat(conversationId);
  }

  async listConversationEvents(payload: {
    conversationId: string;
    maxItems?: number;
  }): Promise<ScheduledConversationEvent[]> {
    return this.ensureScheduler().listConversationEvents(
      payload.conversationId,
      payload.maxItems,
    );
  }

  async getConversationEventCount(payload: { conversationId: string }) {
    return this.ensureScheduler().getConversationEventCount(
      payload.conversationId,
    );
  }

  async createSocialSession(payload: {
    roomId: string;
    workspaceLabel?: string;
  }) {
    this.workerHealthCache = null;
    return await this.requestWorker<{ sessionId: string }>(
      METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async updateSocialSessionStatus(payload: {
    sessionId: string;
    status: RuntimeSocialSessionStatus;
  }) {
    this.workerHealthCache = null;
    return await this.requestWorker<{
      sessionId: string;
      status: RuntimeSocialSessionStatus;
    }>(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS, payload, {
      ensureWorker: true,
      recordActivity: true,
    });
  }

  async queueSocialSessionTurn(payload: {
    sessionId: string;
    prompt: string;
    agentType?: string;
    clientTurnId?: string;
  }) {
    this.workerHealthCache = null;
    return await this.requestWorker<{ turnId: string }>(
      METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async getSocialSessionStatus() {
    const health = await this.getWorkerHealth({ ensureWorker: false });
    return health?.socialSessions ?? createEmptySocialSessionServiceSnapshot();
  }

  async revertSelfModCommit(payload: { commitHash?: string; steps?: number }) {
    return await this.requestWorker<RuntimeSelfModRevertResult>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_REVERT,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async applySelfModCommit(payload: { commitHash?: string }) {
    return await this.requestWorker<RuntimeSelfModApplyResult>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_APPLY,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async getCrashRecoveryStatus() {
    return await this.requestWorker<RuntimeCrashRecoveryStatus>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_CRASH_RECOVERY_STATUS,
      undefined,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async discardUnfinishedSelfModChanges(payload?: { conversationId?: string }) {
    return await this.requestWorker<RuntimeDiscardUnfinishedResult>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_DISCARD_UNFINISHED,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async getLastSelfModCommit() {
    return await this.requestWorker<string | null>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_LAST_COMMIT,
      undefined,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async listRecentSelfModCommits(limit?: number) {
    return await this.requestWorker<SelfModCommitSummary[]>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_RECENT_COMMITS,
      { limit },
      { ensureWorker: true, recordActivity: true },
    );
  }

  async killAllShells() {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS,
      undefined,
      { ensureWorker: false, recordActivity: true },
    );
  }

  async killShellsByPort(port: number) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT,
      { port },
      { ensureWorker: false, recordActivity: true },
    );
  }

  async collectBrowserData(options?: {
    selectedBrowser?: string;
    selectedProfile?: string;
  }) {
    return await this.requestWorker<{ data: unknown; formatted: string }>(
      METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA,
      options,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async collectAllSignals(options?: {
    categories?: string[];
    selectedBrowser?: string;
    selectedProfile?: string;
  }) {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS,
      options,
      { ensureWorker: true, recordActivity: false },
    );
  }

  async coreMemoryExists() {
    const { coreMemoryExists } = await import("../discovery/browser-data.js");
    return await coreMemoryExists(this.options.initializeParams.stellaDataDirPath);
  }

  async discoveryKnowledgeExists() {
    const { discoveryKnowledgeExists } = await import(
      "../discovery/life-knowledge.js"
    );
    return await discoveryKnowledgeExists(
      this.options.initializeParams.stellaDataDirPath,
    );
  }

  async writeCoreMemory(
    content: string,
    options?: { includeLocation?: boolean },
  ) {
    const { writeCoreMemory } = await import("../discovery/browser-data.js");
    await writeCoreMemory(
      this.options.initializeParams.stellaDataDirPath,
      content,
      options,
    );
  }

  async writeDiscoveryKnowledge(payload: DiscoveryKnowledgeSeedPayload) {
    const { writeDiscoveryKnowledge } = await import(
      "../discovery/life-knowledge.js"
    );
    await writeDiscoveryKnowledge(
      this.options.initializeParams.stellaDataDirPath,
      payload,
    );
  }

  async detectPreferredBrowserProfile() {
    const { detectPreferredBrowserProfile } = await import(
      "../discovery/browser-data.js"
    );
    return await detectPreferredBrowserProfile();
  }

  async listBrowserProfiles(browserType: string) {
    const { listBrowserProfiles } = await import(
      "../discovery/browser-data.js"
    );
    return await listBrowserProfiles(
      browserType as import("../discovery/browser-data.js").BrowserType,
    );
  }

  private ensureScheduler() {
    if (!this.schedulerService) {
      throw createRuntimeUnavailableError("Local scheduler is not available.");
    }
    return this.schedulerService;
  }

  private async appendLocalChatEvent(payload: {
    conversationId: string;
    type: string;
    payload?: Record<string, unknown>;
    requestId?: string;
    targetDeviceId?: string;
    deviceId?: string;
    timestamp?: number;
  }) {
    await this.requestWorker<{ ok: true }>(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
    this.events.emit("local-chat-updated", null);
  }

  private async initializeHostServices() {
    await this.stopHostServices();
    this.deviceIdentity = await this.options.hostHandlers.getDeviceIdentity();
    this.ensureHostRemoteTurnBridge();

    const showNotificationHandler = this.options.hostHandlers.showNotification;
    const scheduler = new LocalSchedulerService({
      stellaDataDir: this.options.initializeParams.stellaDataDirPath,
      runnerTarget: {
        getRunner: () => ({
          runAutomationTurn: async (payload) =>
            await this.requestWorker<RuntimeAutomationTurnResult>(
              METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
              payload,
              {
                ensureWorker: true,
                recordActivity: true,
              },
            ),
          getActiveOrchestratorRun: async () => await this.getActiveRun(),
          }),
      },
      // Pop a native banner whenever a scheduled fire delivers a message.
      // Routed through the same Electron handler the runtime uses for
      // in-app notifications (sound preference + grouping respected).
      ...(showNotificationHandler
        ? {
            showNotification: ({ title, body }) => {
              void showNotificationHandler({ title, body });
            },
          }
        : {}),
    });
    scheduler.start();
    this.schedulerService = scheduler;
    this.schedulerSubscription = scheduler.subscribe(() => {
      this.events.emit("schedule-updated", undefined);
    });

    this.hostReady = true;
  }

  private async stopHostServices() {
    this.stopHostRemoteTurnCancelSubscription();
    this.hostRemoteTurnBridge?.stop();
    await this.sendHostGoOffline().catch(() => undefined);
    this.hostRemoteTurnBridge = null;
    this.stopHostHeartbeatLoop();
    this.disposeHostConvexClient();
    this.hostDeviceRegistered = false;
    this.hostDeviceRegistering = false;
    this.hostRemoteTurnAuthWindowStartedAt = 0;
    this.hostRemoteTurnUnauthenticatedFailures = 0;
    this.hostRemoteTurnAuthRecoveryPromise = null;

    this.schedulerSubscription?.();
    this.schedulerSubscription = null;
    this.schedulerService?.stop();
    this.schedulerService = null;
  }

  async googleWorkspaceGetAuthStatus() {
    return await this.requestWorker<{
      connected: boolean;
      unavailable?: boolean;
      email?: string;
      name?: string;
    }>(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS, undefined, {
      ensureWorker: true,
      recordActivity: false,
    });
  }

  async googleWorkspaceConnect() {
    return await this.requestWorker<{
      connected: boolean;
      unavailable?: boolean;
      email?: string;
      name?: string;
    }>(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT, undefined, {
      ensureWorker: true,
      recordActivity: true,
      retryOnceOnDisconnect: true,
    });
  }

  async googleWorkspaceDisconnect() {
    return await this.requestWorker<{ ok: boolean }>(
      METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT,
      undefined,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async triggerDreamNow(
    trigger: "manual" | "startup_catchup" = "manual",
  ): Promise<{
    scheduled: boolean;
    reason:
      | "scheduled"
      | "disabled"
      | "in_flight"
      | "count_failed"
      | "no_inputs"
      | "below_threshold"
      | "lock_busy"
      | "no_api_key"
      | "unavailable";
    pendingItems: number;
    detail?: string;
  }> {
    return await this.requestWorker<{
      scheduled: boolean;
      reason:
        | "scheduled"
        | "disabled"
        | "in_flight"
        | "count_failed"
        | "no_inputs"
        | "below_threshold"
        | "lock_busy"
        | "no_api_key"
        | "unavailable";
      pendingItems: number;
      detail?: string;
    }>(
      METHOD_NAMES.INTERNAL_WORKER_DREAM_TRIGGER_NOW,
      { trigger },
      { ensureWorker: true, recordActivity: true },
    );
  }

  async runChronicleSummaryTick(window: "10m" | "6h"): Promise<
    | {
        wrote: true;
        window: "10m" | "6h";
        uniqueLines: number;
        outPath: string;
      }
    | {
        wrote: false;
        window: "10m" | "6h";
        reason:
          | "disabled"
          | "lock_busy"
          | "no_api_key"
          | "no_captures"
          | "below_threshold"
          | "unchanged"
          | "no_signal"
          | "llm_failed"
          | "write_failed";
        uniqueLines: number;
        detail?: string;
      }
  > {
    return await this.requestWorker(
      METHOD_NAMES.INTERNAL_WORKER_CHRONICLE_SUMMARY_TICK,
      { window },
      { ensureWorker: true, recordActivity: true },
    );
  }

  private buildWorkerInitializationState(): WorkerInitializationState {
    return {
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
      stellaAppDir: this.options.initializeParams.stellaAppDir,
      stellaDataDirPath: this.options.initializeParams.stellaDataDirPath,
      stellaWorkspacePath: this.options.initializeParams.stellaWorkspacePath,
      authToken: this.configCache.authToken ?? null,
      convexUrl: this.configCache.convexUrl ?? null,
      convexSiteUrl: this.configCache.convexSiteUrl ?? null,
      hasConnectedAccount: this.configCache.hasConnectedAccount ?? false,
      cloudSyncEnabled: this.configCache.cloudSyncEnabled ?? false,
      modelCatalogUpdatedAt: this.configCache.modelCatalogUpdatedAt ?? null,
    };
  }

  private async requestWorker<TResult>(
    method: string,
    params: unknown,
    options: {
      ensureWorker: boolean;
      recordActivity: boolean;
      retryOnceOnDisconnect?: boolean;
    },
  ): Promise<TResult> {
    return await this.workerController.request(async (peer) => {
      const result = await peer.request<TResult>(method, params);
      this.workerHealthCache = null;
      return result;
    }, options);
  }

  private async getWorkerHealth(args: { ensureWorker: boolean }) {
    return await this.workerController.getHealth(args);
  }

  private async buildHealthSnapshot(): Promise<RuntimeHealthSnapshot> {
    const workerHealth = await this.getWorkerHealth({
      ensureWorker: false,
    }).catch(() => null);
    return {
      ready: this.hostReady,
      hostPid: process.pid,
      workerPid: workerHealth?.pid ?? null,
      workerRunning:
        this.workerController.getState() === "running" ||
        this.workerController.getState() === "starting",
      workerGeneration: this.workerGeneration,
      deviceId: workerHealth?.deviceId ?? this.deviceIdentity?.deviceId ?? null,
      ...(this.hasPendingWorkerRestartIntent() || this.restartInProgress
        ? { pendingWorkerRestart: true }
        : {}),
      activeRunId: workerHealth?.activeRun?.runId ?? null,
      activeAgentCount: workerHealth?.activeAgentCount ?? 0,
    };
  }

  private registerHostHandlers(peer: JsonRpcPeer) {
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
      async () => {
        if (!this.deviceIdentity) {
          this.deviceIdentity =
            await this.options.hostHandlers.getDeviceIdentity();
        }
        return this.deviceIdentity;
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_DEVICE_HEARTBEAT_SIGN,
      async (params) => {
        const signedAtMs =
          params && typeof params === "object" && "signedAtMs" in params
            ? Number((params as { signedAtMs?: unknown }).signedAtMs)
            : Number.NaN;
        if (!Number.isFinite(signedAtMs)) {
          throw new Error("Invalid host heartbeat signing payload.");
        }
        return await this.options.hostHandlers.signHeartbeatPayload(signedAtMs);
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
      async (params) => {
        return (
          (await this.options.hostHandlers.requestRuntimeAuthRefresh?.(
            params as HostRuntimeAuthRefreshParams,
          )) ?? {
            authenticated: false,
            token: null,
            hasConnectedAccount: false,
          }
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_APP_BROWSER_CONTEXT_GET,
      async () => {
        return (
          (await this.options.hostHandlers.getAppBrowserContext?.()) ?? {
            apps: [],
            activeBrowserTab: null,
          }
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_CREDENTIALS_REQUEST,
      async (params) => {
        return await this.options.hostHandlers.requestCredential(
          params as {
            provider: string;
            label?: string;
            description?: string;
            placeholder?: string;
          },
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_CONNECTOR_TOKEN_STORE_REQUEST,
      async (params) => {
        if (!this.options.hostHandlers.requestConnectorTokenStore) {
          return { ok: false, reason: "unsupported" };
        }
        return await this.options.hostHandlers.requestConnectorTokenStore(
          params as Parameters<
            NonNullable<RuntimeHostHandlers["requestConnectorTokenStore"]>
          >[0],
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_CONNECTOR_CREDENTIAL_REQUEST,
      async (params) => {
        if (!this.options.hostHandlers.requestConnectorCredential) {
          return { ok: false, reason: "unsupported" };
        }
        return await this.options.hostHandlers.requestConnectorCredential(
          params as {
            tokenKey: string;
            displayName: string;
            authType?: "api_key" | "oauth";
            resourceUrl?: string;
            oauthClientId?: string;
            oauthResource?: string;
            scopes?: string[];
            preregisteredOAuth?: {
              clientId: string;
              authorizationEndpoint: string;
              tokenEndpoint?: string;
              responseType?: "code" | "token";
              resourceUrl?: string;
              oauthResource?: string | null;
              callbackUrl?: string;
              callbackId?: string;
              callbackMode?: "local" | "external";
              scopeSeparator?: string;
              usesPkce?: boolean;
              authorizationRedirectParam?: string;
              authorizationParams?: Record<string, string>;
              tokenRedirectParam?: string;
              tokenAuth?: "body" | "basic";
              tokenExchange?: {
                type: "backend";
                provider: string;
              };
            };
            description?: string;
            placeholder?: string;
          },
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST,
      async (params) => {
        if (!this.options.hostHandlers.requestConnectorConnection) {
          return { ok: false, reason: "unsupported" };
        }
        return await this.options.hostHandlers.requestConnectorConnection(
          params as {
            id: string;
            name: string;
            description?: string;
            iconUrl?: string;
            category?: string;
            reason?: string;
            conversationId?: string;
            offerId?: string;
          },
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_CONNECTOR_CONNECT_CANCEL,
      async (params) => {
        if (!this.options.hostHandlers.cancelConnectorConnection) {
          return { ok: false };
        }
        const offerId =
          params && typeof params === "object"
            ? String((params as { offerId?: unknown }).offerId ?? "")
            : "";
        if (!offerId) return { ok: false };
        return await this.options.hostHandlers.cancelConnectorConnection({
          offerId,
        });
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_BROWSER_EXTENSION_CONNECT_REQUEST,
      async (params) => {
        if (!this.options.hostHandlers.requestBrowserExtensionConnect) {
          return { ok: false, reason: "unsupported" };
        }
        return await this.options.hostHandlers.requestBrowserExtensionConnect(
          params as {
            conversationId?: string;
            agentId?: string;
            command?: string;
            offerId?: string;
          },
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_COMPUTER_USE_APP_APPROVAL_REQUEST,
      async (params) => {
        if (!this.options.hostHandlers.requestComputerUseAppApproval) {
          return { decision: "declined", scope: "none" };
        }
        return await this.options.hostHandlers.requestComputerUseAppApproval(
          params as {
            bundleIdentifier: string;
            displayName: string;
            appPath?: string;
            allowPersistentApproval: boolean;
            risk?: string;
            warningSubtitle?: string;
          },
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_DISPLAY_UPDATE,
      async (params) => {
        await this.options.hostHandlers.displayUpdate(
          parseDisplayUpdateParams(params),
        );
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_NOTIFICATION_SHOW,
      async (params) => {
        await this.options.hostHandlers.showNotification?.(
          params as { title: string; body: string; sound?: string },
        );
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_SYSTEM_REQUEST_PERMISSION,
      async (params) => {
        const kind = String(params ?? "");
        if (kind !== "accessibility" && kind !== "screen") {
          return {
            granted: false,
            alreadyGranted: false,
            reason: "unsupported",
          };
        }
        if (!this.options.hostHandlers.requestDesktopPermission) {
          return {
            granted: false,
            alreadyGranted: false,
            reason: "unsupported",
          };
        }
        return await this.options.hostHandlers.requestDesktopPermission(kind);
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_SYSTEM_OPEN_EXTERNAL,
      async (params) => {
        await this.options.hostHandlers.openExternal?.(String(params ?? ""));
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_WINDOW_SHOW,
      async (params) => {
        await this.options.hostHandlers.showWindow?.(
          params as HostWindowTarget,
        );
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_WINDOW_FOCUS,
      async (params) => {
        await this.options.hostHandlers.focusWindow?.(
          params as HostWindowTarget,
        );
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE,
      async (params) => {
        const payload = params as { runId?: string };
        if (!payload.runId) {
          throw new Error("HOST_RUNTIME_RELOAD_PAUSE requires a runId.");
        }
        await this.pauseRuntimeReloads(payload.runId);
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME,
      async (params) => {
        const payload = params as {
          runId?: string;
          allowDeferredReload?: boolean;
        };
        if (!payload.runId) {
          throw new Error("HOST_RUNTIME_RELOAD_RESUME requires a runId.");
        }
        await this.resumeRuntimeReloads(payload.runId, {
          allowDeferredReload: payload.allowDeferredReload !== false,
        });
        return { ok: true };
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
      async (params) => {
        const payload = params as {
          transitionId?: string;
          runIds?: string[];
          stateRunIds?: string[];
          requiresFullReload?: boolean;
          requiresRuntimeRestart?: boolean;
          requiresProcessRestart?: boolean;
        };
        if (!payload.transitionId) {
          throw new Error("HOST_HMR_RUN_TRANSITION requires a transitionId.");
        }
        const runIds = Array.isArray(payload.runIds) ? payload.runIds : [];
        if (runIds.length === 0) {
          throw new Error(
            "HOST_HMR_RUN_TRANSITION requires a non-empty runIds array.",
          );
        }
        const runHmrTransition = this.options.hostHandlers.runHmrTransition;
        if (!runHmrTransition) {
          throw new Error("HOST_HMR_RUN_TRANSITION handler is not registered.");
        }
        await this.withMorphTransitionInFlight(() =>
          runHmrTransition({
          runIds,
          stateRunIds: Array.isArray(payload.stateRunIds)
            ? payload.stateRunIds.filter((runId) => typeof runId === "string")
            : runIds,
          requiresFullReload: Boolean(payload.requiresFullReload),
          requiresRuntimeRestart: Boolean(payload.requiresRuntimeRestart),
          requiresProcessRestart: Boolean(payload.requiresProcessRestart),
          applyBatch: async (options) => {
            const result = await this.requestWorker<{
              ok?: boolean;
              reason?: string;
              requiresClientFullReload?: boolean;
            }>(
              METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR,
              {
                transitionId: payload.transitionId,
                runIds,
                ...(options ? { options } : {}),
              },
              { ensureWorker: false, recordActivity: true },
            );
            if (result?.ok === false) {
              throw new Error(
                `Self-mod HMR apply failed${result.reason ? `: ${result.reason}` : ""}`,
              );
            }
            return {
              requiresClientFullReload:
                result?.requiresClientFullReload === true,
            };
          },
          reportState: async (state) => {
            const stateRunIds = Array.isArray(payload.stateRunIds)
              ? payload.stateRunIds.filter((runId) => typeof runId === "string")
              : runIds;
            const emitRunIds = stateRunIds.length > 0 ? stateRunIds : runIds;
            for (const runId of new Set(emitRunIds)) {
              this.events.emit("run-self-mod-hmr-state", {
                runId,
                state,
              });
            }
          },
        }),
        );
        // Runtime-relevant apply with no dev watcher running (packaged /
        // prod): nothing else will restart the worker for this change, so
        // route it through the stale-worker policy — restart now when idle,
        // defer (persisted across the Electron relaunch that a
        // process-restart apply triggers) when busy. In dev the
        // dist-electron watcher owns runtime reloads and this stays off.
        if (
          !this.watcher &&
          (payload.requiresRuntimeRestart === true ||
            payload.requiresProcessRestart === true)
        ) {
          await this.noteRuntimeCodeChangedByApply(
            payload.requiresProcessRestart === true
              ? "self-mod-apply-process-restart"
              : "self-mod-apply-runtime-restart",
          );
        }
        return { ok: true };
      },
    );

    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS,
      async () => await this.listCronJobs(),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB,
      async (params) =>
        await this.ensureScheduler().addCronJob(
          params as LocalCronJobCreateInput,
        ),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB,
      async (params) => {
        const payload = params as {
          jobId: string;
          patch: LocalCronJobUpdatePatch;
        };
        return await this.ensureScheduler().updateCronJob(
          payload.jobId,
          payload.patch,
        );
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB,
      async (params) =>
        await this.ensureScheduler().removeCronJob(
          (params as { jobId: string }).jobId,
        ),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB,
      async (params) =>
        await this.ensureScheduler().runCronJob(
          (params as { jobId: string }).jobId,
        ),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG,
      async (params) =>
        await this.ensureScheduler().getHeartbeatConfig(
          (params as { conversationId: string }).conversationId,
        ),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT,
      async (params) =>
        await this.ensureScheduler().upsertHeartbeat(
          params as LocalHeartbeatUpsertInput,
        ),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT,
      async (params) =>
        await this.ensureScheduler().runHeartbeat(
          (params as { conversationId: string }).conversationId,
        ),
    );
  }

  private registerNotifications(peer: JsonRpcPeer) {
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.RUNTIME_READY,
      (params) => {
        this.events.emit("runtime-ready", params as RuntimeHealthSnapshot);
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.RUNTIME_RELOADING,
      (params) => {
        this.events.emit("runtime-reloading", params as { reason: string });
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.RUNTIME_LAGGED,
      (params) => {
        this.events.emit("runtime-lagged", params as { droppedCount: number });
      },
    );
    peer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_EVENT, (params) => {
      const payload = params as RuntimeAgentEventPayload;
      bufferAgentEvent(this.agentEventBuffers, payload);
      pruneAgentEventBuffers(this.agentEventBuffers);
      this.handleConnectorStreamRunEvent(payload);
      this.events.emit("run-event", payload);
      // Ack only ordinary recorder events. Terminal events must remain
      // replayable until the retention sweep, otherwise an Electron
      // restart between host receipt and renderer resume can strand the
      // UI in an active run. Synthetic task seqs are Date.now-scale and
      // would prune lower ordinary run seqs, including terminal rows.
      if (payload.runId && shouldAckWorkerRunEvent(payload)) {
        this.scheduleRunEventAck(payload.runId, payload.seq);
      }
      if (payload.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
        if (payload.runId) {
          // Run-liveness backstop: a finished run must not keep holding a
          // self-mod reload pause (see forceReleaseRuntimeReloadPause).
          this.scheduleRuntimeReloadPauseReleaseForFinishedRun(payload.runId);
        }
        if (this.hasPendingWorkerRestartIntent()) {
          // A deferred worker restart is waiting for the worker to go idle;
          // give immediate follow-up runs a moment to register before the
          // unified gate re-checks.
          const timer = setTimeout(() => {
            void this.flushWorkerRestart();
          }, 500);
          timer.unref?.();
        }
      }
    });
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.RUN_SELF_MOD_HMR_STATE,
      (params) => {
        this.events.emit(
          "run-self-mod-hmr-state",
          params as { runId?: string; state: SelfModHmrState },
        );
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.VOICE_AGENT_EVENT,
      (params) => {
        this.events.emit(
          "voice-agent-event",
          params as RuntimeVoiceAgentEventPayload,
        );
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.VOICE_SELF_MOD_HMR_STATE,
      (params) => {
        this.events.emit(
          "voice-self-mod-hmr-state",
          params as RuntimeVoiceHmrStatePayload,
        );
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED,
      (params) => {
        const payload = params as LocalChatUpdatedPayload | null;
        this.handleLocalChatUpdateForConnectorFollowup(payload);
        this.events.emit("local-chat-updated", payload);
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED,
      (params) => {
        this.events.emit(
          "thread-activity-updated",
          params as ThreadActivityUpdatedPayload,
        );
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.SCHEDULE_UPDATED,
      () => {
        this.events.emit("schedule-updated", undefined);
      },
    );
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.MODEL_CATALOG_UPDATED,
      (params) => {
        this.events.emit(
          "model-catalog-updated",
          params as RuntimeModelCatalogSnapshot,
        );
      },
    );
  }

  private startDevWatcher(workerEntryPath: string) {
    if (!this.options.initializeParams.isDev || this.watcher) return;
    // Watch only the bundled `runtime/` subtree, not the whole dist-electron
    // tree (which also holds the 14.6MB main.js and the CLI bundles).
    // `shouldReloadRuntime` only ever matches "runtime/..." paths, so a single
    // esbuild rebuild that rewrites main.js no longer wakes this watcher and
    // cold-respawns the worker. The watch callback's `filename` is relative to
    // the watched root, so re-prefix it with "runtime/" to keep the matcher's
    // contract intact.
    const runtimeBundleRoot = path.resolve(path.dirname(workerEntryPath), "..");
    this.watcher = watch(
      runtimeBundleRoot,
      { recursive: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !filename.endsWith(".js")) return;
        const runtimeRelative = `runtime/${filename.replace(/\\/g, "/")}`;
        if (!shouldReloadRuntime(runtimeRelative)) return;
        void this.scheduleRuntimeReload();
      },
    );
  }
}

const resolveDefaultWorkerEntryPath = (options: StellaRuntimeHostOptions) => {
  if (options.workerEntryPath) {
    return options.workerEntryPath;
  }
  return resolveBundledRuntimeFile("worker/entry.js");
};

const shouldReloadRuntime = (normalizedFilename: string): boolean => {
  const hostOwnedRuntimeKernelPrefixes = [
    "runtime/kernel/convex-urls",
    "runtime/kernel/dev-projects/",
    "runtime/kernel/home/",
    "runtime/kernel/local-scheduler-service",
    "runtime/kernel/preferences/local-preferences",
    "runtime/kernel/shared/",
    "runtime/kernel/storage/",
    "runtime/kernel/tools/network-guards",
    "runtime/kernel/tools/stella-browser-bridge-config",
  ];
  if (
    normalizedFilename.startsWith("runtime/discovery/") &&
    !normalizedFilename.startsWith("runtime/discovery/browser-data")
  ) {
    return true;
  }
  if (
    normalizedFilename.startsWith("runtime/kernel/") &&
    !hostOwnedRuntimeKernelPrefixes.some((prefix) =>
      normalizedFilename.startsWith(prefix),
    )
  ) {
    return true;
  }
  if (
    normalizedFilename.startsWith("runtime/ai/") ||
    normalizedFilename.startsWith("runtime/worker/") ||
    normalizedFilename.startsWith("runtime/protocol/jsonl")
  ) {
    return true;
  }
  return false;
};
