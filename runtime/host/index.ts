import { EventEmitter } from "node:events";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readConfiguredConvexUrl } from "../kernel/convex-urls.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import { createRemoteTurnBridge } from "../kernel/remote-turn-bridge.js";
import {
  isConvexUnauthenticatedError,
  shouldStopRemoteTurnForAuthFailure,
} from "../kernel/runner/remote-turn-auth.js";
import type {
  LocalCronJobCreateInput,
  LocalCronJobUpdatePatch,
  LocalHeartbeatUpsertInput,
} from "../kernel/shared/scheduling.js";
import type {
  DiscoveryKnowledgeSeedPayload,
} from "../contracts/discovery.js";
import type { LocalChatUpdatedPayload } from "../contracts/local-chat.js";
import { createEmptySocialSessionServiceSnapshot } from "../contracts/index.js";
import { AGENT_STREAM_EVENT_TYPES } from "../contracts/agent-runtime.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type HostDeviceIdentity,
  type HostRuntimeAuthRefreshParams,
  type HostRuntimeAuthRefreshResult,
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
  type RuntimeSelfModRevertResult,
  type RuntimeLocalAgentRequest,
  type RuntimeLocalAgentSnapshot,
  type RuntimeOneShotCompletionRequest,
  type RuntimeOneShotCompletionResult,
  type RuntimeVoiceActionCompletedPayload,
  type RuntimeVoiceAgentEventPayload,
  type RuntimeVoiceChatPayload,
  type RuntimeVoiceHmrStatePayload,
  type RuntimeVoiceTranscriptPayload,
  type RuntimeWebSearchResult,
  type RunResumeEventsResult,
  type ScheduledConversationEvent,
  type SelfModFeatureSnapshot,
  type SelfModFeatureSummary,
  type SelfModHmrState,
  type StoreInstallRecord,
  type StorePackageRecord,
  type StorePackageReleaseRecord,
  type StorePublishArgs,
  type StorePublishBlueprintArgs,
  type StoreThreadSendInput,
  type StoreThreadSnapshot,
  type RuntimeInitializeParams,
  type RuntimeInitializeResult,
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
  "voice-action-completed": RuntimeVoiceActionCompletedPayload;
  "local-chat-updated": LocalChatUpdatedPayload | null;
  "store-thread-updated": StoreThreadSnapshot;
  "schedule-updated": void;
  "google-workspace-auth-required": void;
};

export type RuntimeHostHandlers = {
  getActiveConversationId?: () => Promise<string | null> | string | null;
  getDeviceIdentity: () => Promise<HostDeviceIdentity>;
  signHeartbeatPayload: (signedAtMs: number) => Promise<HostHeartbeatSignature>;
  requestRuntimeAuthRefresh?: (
    params: HostRuntimeAuthRefreshParams,
  ) => Promise<HostRuntimeAuthRefreshResult>;
  requestCredential: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
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
    /**
     * Triggers the worker-side overlay apply for this batch (POSTs `/apply`
     * to the Vite plugin). Called by the host once the morph cover is on
     * screen so the renderer never visibly crosses the swap.
     */
    applyBatch: (
      options?: {
        suppressClientFullReload?: boolean;
        forceClientFullReload?: boolean;
      },
    ) => Promise<{ requiresClientFullReload?: boolean } | void>;
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
  stellaRoot: string;
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
const WORKER_UNFOCUSED_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const SELF_MOD_RUNTIME_RELOAD_STATE_FILE = ".stella-runtime-reload-state.json";
const DEVICE_HEARTBEAT_INTERVAL_MS = 30_000;

type RemoteTurnAuthSource = HostRuntimeAuthRefreshParams["source"];

const parseDisplayUpdateParams = (
  params: unknown,
): Record<string, unknown> => {
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
  buffers: Map<string, { events: RuntimeAgentEventPayload[]; updatedAt: number }>,
) => {
  const now = Date.now();
  for (const [runId, buffer] of buffers.entries()) {
    if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
      buffers.delete(runId);
    }
  }
};

const bufferAgentEvent = (
  buffers: Map<string, { events: RuntimeAgentEventPayload[]; updatedAt: number }>,
  event: RuntimeAgentEventPayload,
) => {
  const existing = buffers.get(event.runId);
  if (existing) {
    existing.events.push(event);
    if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
      existing.events.splice(0, existing.events.length - AGENT_EVENT_BUFFER_LIMIT);
    }
    existing.updatedAt = Date.now();
    return;
  }
  buffers.set(event.runId, { events: [event], updatedAt: Date.now() });
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
  private scheduledRuntimeReload = false;
  private deferredRuntimeReload = false;
  private readonly pausedRuntimeReloadRuns = new Set<string>();
  private reloadQueue = Promise.resolve();
  private configCache: RuntimeConfigureParams = {};
  private deviceIdentity: HostDeviceIdentity | null = null;
  private workerGeneration = 0;
  private started = false;
  private hostReady = false;
  private hostConvexClient: ConvexClient | null = null;
  private hostConvexClientUrl: string | null = null;
  private hostConvexClientAuthToken: string | null = null;
  private hostRemoteTurnBridge: ReturnType<typeof createRemoteTurnBridge> | null = null;
  private hostDeviceRegistered = false;
  private hostDeviceRegistering = false;
  private hostHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private hostRemoteTurnAuthWindowStartedAt = 0;
  private hostRemoteTurnUnauthenticatedFailures = 0;
  private hostRemoteTurnAuthRecoveryPromise: Promise<boolean> | null = null;
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
    { requestId: string; backendConversationId: string }
  >();

  constructor(private readonly options: StellaRuntimeHostOptions) {
    const stellaRoot = this.options.initializeParams.stellaRoot;
    const udsFactory = buildUdsConnectionFactory({
      stellaRoot,
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
        await killDetachedWorker(stellaRoot);
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
          initializeResult.protocolVersion !==
          STELLA_RUNTIME_PROTOCOL_VERSION
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
      onConnectionStarted: async () => {
        this.workerGeneration += 1;
        this.workerHealthCache = await this.workerController.getHealth({
          ensureWorker: false,
        });
        this.events.emit("runtime-ready", await this.health());
      },
      onUnexpectedExit: async () => {
        this.workerHealthCache = null;
        if (this.started) {
          this.events.emit("runtime-ready", await this.health());
        }
      },
      onAfterStop: async (reason) => {
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
      idleTimeoutMs: WORKER_UNFOCUSED_IDLE_TIMEOUT_MS,
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
      this.options.initializeParams.stellaRoot,
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
    this.pausedRuntimeReloadRuns.add(runId);
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
    const hadDeferredReload = this.deferredRuntimeReload;
    this.deferredRuntimeReload = false;
    if (!hadDeferredReload || options?.allowDeferredReload === false) {
      return;
    }
    setTimeout(() => {
      void this.scheduleRuntimeReload();
    }, 0);
  }

  private async resetRuntimeReloadPauses() {
    const hadPausedRuns = this.pausedRuntimeReloadRuns.size > 0;
    const hadDeferredReload = this.deferredRuntimeReload;
    this.pausedRuntimeReloadRuns.clear();
    this.deferredRuntimeReload = false;
    await this.persistRuntimeReloadPauseState();
    if (hadPausedRuns && hadDeferredReload) {
      setTimeout(() => {
        void this.scheduleRuntimeReload();
      }, 0);
    }
  }

  private async scheduleRuntimeReload() {
    if (this.pausedRuntimeReloadRuns.size > 0) {
      this.deferredRuntimeReload = true;
      return;
    }
    this.scheduledRuntimeReload = true;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      const shouldReload = this.scheduledRuntimeReload;
      this.reloadTimer = null;
      this.scheduledRuntimeReload = false;
      if (!shouldReload) {
        return;
      }
      this.reloadQueue = this.reloadQueue
        .catch(() => undefined)
        .then(async () => {
          await this.restartWorker();
        });
    }, 150);
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
      (await this.options.hostHandlers.getActiveConversationId?.())?.trim() ?? "";
    return activeConversationId || await this.getOrCreateDefaultConversationId();
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
          console.info(`[remote-turn] Recovered host auth after ${source} failure.`);
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

  private async sendHostHeartbeat(): Promise<void> {
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
      this.hostDeviceRegistered = true;
      this.noteHostRemoteTurnAuthHealthy();
    } catch (error) {
      const authFailure = this.handleHostRemoteTurnAuthFailure("register", error);
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
    if (!this.getConfiguredHostAuthToken() || !this.getConfiguredHostConvexUrl()) {
      this.hostDeviceRegistered = false;
      return;
    }
    const deviceId = this.deviceIdentity?.deviceId;
    if (!deviceId) {
      this.hostDeviceRegistered = false;
      return;
    }
    const client = this.ensureHostConvexClient();
    if (!client) {
      return;
    }

    try {
      await (client as any).mutation(
        (
          anyApi as unknown as {
            agent: { device_resolver: { goOffline: unknown } };
          }
        ).agent.device_resolver.goOffline,
        { deviceId },
      );
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
      runLocalTurn: async ({ requestId, conversationId, userPrompt, agentType }) => {
        const localConversationId =
          this.configCache.cloudSyncEnabled
            ? conversationId || await this.getOrCreateDefaultConversationId()
            : await this.getActiveLocalConversationId();
        // Arm follow-up routing before the orchestrator turn runs so any
        // assistant message the worker persists during this run already
        // routes back to the connector. The map entry is cleared by the
        // local-chat listener as soon as the user sends a non-connector
        // message in this conversation.
        this.connectorTargetsByLocalConversation.set(localConversationId, {
          requestId,
          backendConversationId: conversationId,
        });
        await this.appendLocalChatEvent({
          conversationId: localConversationId,
          type: "user_message",
          payload: { text: userPrompt, source: "connector" },
        });
        const result = await this.requestWorker<RuntimeAutomationTurnResult>(
          METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION,
          {
            conversationId: localConversationId,
            userPrompt,
            ...(agentType ? { agentType } : {}),
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
        return result;
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
            channels: { connector_delivery: { sendConnectorFollowup: unknown } };
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

  private handleLocalChatUpdateForConnectorFollowup(
    payload: LocalChatUpdatedPayload | null,
  ): void {
    if (!payload) return;
    const conversationId = payload.conversationId;
    const event = payload.event;
    if (!conversationId || !event) return;

    const target = this.connectorTargetsByLocalConversation.get(conversationId);
    if (!target) return;

    const eventPayload = event.payload as Record<string, unknown> | undefined;
    const source =
      typeof eventPayload?.source === "string" ? eventPayload.source : "";

    if (event.type === "user_message") {
      // The desktop user typed in this conversation — switch routing back
      // to the desktop. Connector-sourced user messages (the ones armed
      // by `runLocalTurn` above) keep the target alive.
      if (source !== "connector") {
        this.connectorTargetsByLocalConversation.delete(conversationId);
      }
      return;
    }

    if (event.type !== "assistant_message") return;
    // The first orchestrator reply already shipped through
    // `completeRemoteTurn`; the host marked that one with
    // `source: "connector"`. Everything else is a real follow-up.
    if (source === "connector") return;

    const text =
      typeof eventPayload?.text === "string" ? eventPayload.text.trim() : "";
    if (!text) return;

    void this.sendConnectorFollowup({
      requestId: target.requestId,
      backendConversationId: target.backendConversationId,
      text,
    });
  }

  private syncHostRemoteTurnBridge() {
    if (!this.started || !this.hostReady) {
      this.stopHostHeartbeatLoop();
      this.hostRemoteTurnBridge?.stop();
      void this.sendHostGoOffline().finally(() => {
        this.disposeHostConvexClient();
      });
      return;
    }

    const authToken = this.getConfiguredHostAuthToken();
    const convexUrl = this.getConfiguredHostConvexUrl();
    if (!authToken || !convexUrl) {
      this.stopHostHeartbeatLoop();
      this.hostRemoteTurnBridge?.stop();
      this.hostDeviceRegistered = false;
      this.hostDeviceRegistering = false;
      this.disposeHostConvexClient();
      return;
    }
    if (!this.configCache.hasConnectedAccount) {
      this.stopHostHeartbeatLoop();
      this.hostRemoteTurnBridge?.stop();
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
  }

  on<K extends keyof RuntimeHostEvents>(
    eventName: K,
    listener: (payload: RuntimeHostEvents[K]) => void,
  ): () => void {
    this.events.on(eventName, listener as (...args: unknown[]) => void);
    return () => {
      this.events.removeListener(eventName, listener as (...args: unknown[]) => void);
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
    this.started = false;
    this.hostReady = false;
    this.workerHealthCache = null;
    this.workerGeneration = 0;
    this.agentEventBuffers.clear();
    this.pendingRunEventAcks.clear();
    if (this.runEventAckTimer) clearTimeout(this.runEventAckTimer);
    this.runEventAckTimer = null;
    this.pausedRuntimeReloadRuns.clear();
    this.deferredRuntimeReload = false;
    this.scheduledRuntimeReload = false;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.persistRuntimeReloadPauseState().catch(() => undefined);
    await this.workerController.stop(options?.killWorker ? "restart" : "stopped");
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
    return await connection.peer.request(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, params);
  }

  async health(): Promise<RuntimeHealthSnapshot> {
    return await this.buildHealthSnapshot();
  }

  async restartWorker() {
    this.events.emit("runtime-reloading", { reason: "worker-restart" });
    await this.workerController.stop("restart");
    await this.workerController.ensureStarted();
    return { ok: true };
  }

  async warmWorker() {
    await this.workerController.ensureStarted();
    return { ok: true };
  }

  setHostFocused(focused: boolean) {
    this.workerController.setHostFocused(focused);
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
    interrupt?: boolean;
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
      const exhausted =
        oldestSeq !== null && payload.lastSeq < oldestSeq - 1;
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
    suggestions?: unknown[];
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

  async publishStoreBlueprint(args: StorePublishBlueprintArgs) {
    return await this.requestWorker<StorePackageReleaseRecord>(
      METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_BLUEPRINT,
      args,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async uninstallStoreMod(packageId: string) {
    return await this.requestWorker<{ packageId: string; revertedCommits: string[] }>(
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

  async getStoreThread() {
    return await this.requestWorker<StoreThreadSnapshot>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_GET,
      {},
      {
        ensureWorker: true,
        recordActivity: false,
      },
    );
  }

  async sendStoreThreadMessage(payload: StoreThreadSendInput) {
    return await this.requestWorker<StoreThreadSnapshot>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_SEND_MESSAGE,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async cancelStoreThreadTurn() {
    return await this.requestWorker<StoreThreadSnapshot>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_CANCEL,
      {},
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async denyLatestStoreBlueprint() {
    return await this.requestWorker<StoreThreadSnapshot>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_DENY_LATEST_BLUEPRINT,
      {},
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async markStoreBlueprintPublished(payload: {
    messageId: string;
    releaseNumber: number;
  }) {
    return await this.requestWorker<StoreThreadSnapshot>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_THREAD_MARK_BLUEPRINT_PUBLISHED,
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
    return this.ensureScheduler().getConversationEventCount(payload.conversationId);
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
    }>(
      METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
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

  async revertSelfModFeature(payload: { featureId?: string; steps?: number }) {
    return await this.requestWorker<RuntimeSelfModRevertResult>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_REVERT,
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

  async discardUnfinishedSelfModChanges() {
    return await this.requestWorker<RuntimeDiscardUnfinishedResult>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_DISCARD_UNFINISHED,
      undefined,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async getLastSelfModFeature() {
    return await this.requestWorker<string | null>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_LAST_FEATURE,
      undefined,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async listRecentSelfModFeatures(limit?: number) {
    return await this.requestWorker<SelfModFeatureSummary[]>(
      METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_RECENT_FEATURES,
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
    return await coreMemoryExists(this.options.initializeParams.stellaRoot);
  }

  async discoveryKnowledgeExists() {
    const { discoveryKnowledgeExists } = await import(
      "../discovery/life-knowledge.js"
    );
    return await discoveryKnowledgeExists(this.options.initializeParams.stellaRoot);
  }

  async writeCoreMemory(
    content: string,
    options?: { includeLocation?: boolean },
  ) {
    const { writeCoreMemory } = await import("../discovery/browser-data.js");
    await writeCoreMemory(
      this.options.initializeParams.stellaRoot,
      content,
      options,
    );
  }

  async writeDiscoveryKnowledge(payload: DiscoveryKnowledgeSeedPayload) {
    const { writeDiscoveryKnowledge } = await import(
      "../discovery/life-knowledge.js"
    );
    await writeDiscoveryKnowledge(this.options.initializeParams.stellaRoot, payload);
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
      stellaHome: this.options.initializeParams.stellaRoot,
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
    trigger:
      | "manual"
      | "subagent_finalize"
      | "chronicle_summary"
      | "startup_catchup" = "manual",
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
    pendingThreadSummaries: number;
    pendingExtensions: number;
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
      pendingThreadSummaries: number;
      pendingExtensions: number;
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
      stellaRoot: this.options.initializeParams.stellaRoot,
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
    return await this.workerController.request(
      async (peer) => {
        const result = await peer.request<TResult>(method, params);
        this.workerHealthCache = null;
        return result;
      },
      options,
    );
  }

  private async getWorkerHealth(args: { ensureWorker: boolean }) {
    return await this.workerController.getHealth(args);
  }

  private async buildHealthSnapshot(): Promise<RuntimeHealthSnapshot> {
    const workerHealth = await this.getWorkerHealth({ ensureWorker: false }).catch(
      () => null,
    );
    return {
      ready: this.hostReady,
      hostPid: process.pid,
      workerPid: workerHealth?.pid ?? null,
      workerRunning:
        this.workerController.getState() === "running" ||
        this.workerController.getState() === "starting",
      workerGeneration: this.workerGeneration,
      deviceId: workerHealth?.deviceId ?? this.deviceIdentity?.deviceId ?? null,
      activeRunId: workerHealth?.activeRun?.runId ?? null,
      activeAgentCount: workerHealth?.activeAgentCount ?? 0,
    };
  }

  private registerHostHandlers(peer: JsonRpcPeer) {
    peer.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_IDENTITY_GET, async () => {
      if (!this.deviceIdentity) {
        this.deviceIdentity = await this.options.hostHandlers.getDeviceIdentity();
      }
      return this.deviceIdentity;
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_HEARTBEAT_SIGN, async (params) => {
      const signedAtMs =
        params && typeof params === "object" && "signedAtMs" in params
          ? Number((params as { signedAtMs?: unknown }).signedAtMs)
          : Number.NaN;
      if (!Number.isFinite(signedAtMs)) {
        throw new Error("Invalid host heartbeat signing payload.");
      }
      return await this.options.hostHandlers.signHeartbeatPayload(signedAtMs);
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH, async (params) => {
      return await this.options.hostHandlers.requestRuntimeAuthRefresh?.(
        params as HostRuntimeAuthRefreshParams,
      ) ?? {
        authenticated: false,
        token: null,
        hasConnectedAccount: false,
      };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, async (params) => {
      return await this.options.hostHandlers.requestCredential(
        params as {
          provider: string;
          label?: string;
          description?: string;
          placeholder?: string;
        },
      );
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_DISPLAY_UPDATE, async (params) => {
      await this.options.hostHandlers.displayUpdate(parseDisplayUpdateParams(params));
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_NOTIFICATION_SHOW, async (params) => {
      await this.options.hostHandlers.showNotification?.(
        params as { title: string; body: string; sound?: string },
      );
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_SYSTEM_OPEN_EXTERNAL, async (params) => {
      await this.options.hostHandlers.openExternal?.(String(params ?? ""));
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_WINDOW_SHOW, async (params) => {
      await this.options.hostHandlers.showWindow?.(params as HostWindowTarget);
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_WINDOW_FOCUS, async (params) => {
      await this.options.hostHandlers.focusWindow?.(params as HostWindowTarget);
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE, async (params) => {
      const payload = params as { runId?: string };
      if (!payload.runId) {
        throw new Error("HOST_RUNTIME_RELOAD_PAUSE requires a runId.");
      }
      await this.pauseRuntimeReloads(payload.runId);
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME, async (params) => {
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
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, async (params) => {
      const payload = params as {
        transitionId?: string;
        runIds?: string[];
        stateRunIds?: string[];
        requiresFullReload?: boolean;
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
      await runHmrTransition({
        runIds,
        stateRunIds: Array.isArray(payload.stateRunIds)
          ? payload.stateRunIds.filter((runId) => typeof runId === "string")
          : runIds,
        requiresFullReload: Boolean(payload.requiresFullReload),
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
      });
      return { ok: true };
    });

    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS,
      async () => await this.listCronJobs(),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB,
      async (params) => await this.ensureScheduler().addCronJob(params as LocalCronJobCreateInput),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB,
      async (params) => {
        const payload = params as { jobId: string; patch: LocalCronJobUpdatePatch };
        return await this.ensureScheduler().updateCronJob(payload.jobId, payload.patch);
      },
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB,
      async (params) =>
        await this.ensureScheduler().removeCronJob((params as { jobId: string }).jobId),
    );
    peer.registerRequestHandler(
      METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB,
      async (params) =>
        await this.ensureScheduler().runCronJob((params as { jobId: string }).jobId),
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
        await this.ensureScheduler().upsertHeartbeat(params as LocalHeartbeatUpsertInput),
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
    peer.registerNotificationHandler(NOTIFICATION_NAMES.RUNTIME_READY, (params) => {
      this.events.emit("runtime-ready", params as RuntimeHealthSnapshot);
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.RUNTIME_RELOADING, (params) => {
      this.events.emit("runtime-reloading", params as { reason: string });
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.RUNTIME_LAGGED, (params) => {
      this.events.emit("runtime-lagged", params as { droppedCount: number });
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_EVENT, (params) => {
      const payload = params as RuntimeAgentEventPayload;
      bufferAgentEvent(this.agentEventBuffers, payload);
      pruneAgentEventBuffers(this.agentEventBuffers);
      this.events.emit("run-event", payload);
      // Ack back to the worker so the persistent event log can prune.
      // The host's own buffer is what consumers read from on
      // renderer-reload, so by this point we've taken responsibility
      // for the event.
      if (payload.runId && Number.isFinite(payload.seq)) {
        this.scheduleRunEventAck(payload.runId, payload.seq);
        if (payload.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
          this.flushRunEventAcks();
        }
      }
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_SELF_MOD_HMR_STATE, (params) => {
      this.events.emit(
        "run-self-mod-hmr-state",
        params as { runId?: string; state: SelfModHmrState },
      );
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, (params) => {
      this.events.emit("voice-agent-event", params as RuntimeVoiceAgentEventPayload);
    });
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.VOICE_ACTION_COMPLETED,
      (params) => {
        this.events.emit(
          "voice-action-completed",
          params as RuntimeVoiceActionCompletedPayload,
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
    peer.registerNotificationHandler(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, (params) => {
      const payload = params as LocalChatUpdatedPayload | null;
      this.handleLocalChatUpdateForConnectorFollowup(payload);
      this.events.emit("local-chat-updated", payload);
    });
    peer.registerNotificationHandler(
      NOTIFICATION_NAMES.STORE_THREAD_UPDATED,
      (params) => {
        this.events.emit(
          "store-thread-updated",
          params as StoreThreadSnapshot,
        );
      },
    );
    peer.registerNotificationHandler(NOTIFICATION_NAMES.SCHEDULE_UPDATED, () => {
      this.events.emit("schedule-updated", undefined);
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.GOOGLE_WORKSPACE_AUTH_REQUIRED, () => {
      this.events.emit("google-workspace-auth-required");
    });
  }

  private startDevWatcher(workerEntryPath: string) {
    if (!this.options.initializeParams.isDev || this.watcher) return;
    const distElectronRoot = path.resolve(
      path.dirname(workerEntryPath),
      "..",
      "..",
      "..",
    );
    this.watcher = watch(distElectronRoot, { recursive: true }, (_eventType, filename) => {
      if (typeof filename !== "string" || !filename.endsWith(".js")) return;
      if (!shouldReloadRuntime(filename.replace(/\\/g, "/"))) return;
      void this.scheduleRuntimeReload();
    });
  }
}

const resolveDefaultWorkerEntryPath = (options: StellaRuntimeHostOptions) =>
  options.workerEntryPath ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "worker",
    "entry.js",
  );

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
