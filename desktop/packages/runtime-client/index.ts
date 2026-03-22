import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
  type AgentHealth,
  type HostDeviceIdentity,
  type HostDisplayUpdateParams,
  type HostHeartbeatSignature,
  type HostUiActParams,
  type HostWindowTarget,
  type InstalledStoreModRecord,
  type LocalCronJobRecord,
  type LocalDevProjectRecord,
  type LocalHeartbeatConfigRecord,
  type RuntimeActiveRun,
  type RuntimeAgentEventPayload,
  type RuntimeAutomationTurnRequest,
  type RuntimeAutomationTurnResult,
  type RuntimeChatPayload,
  type RuntimeCommandRunParams,
  type RuntimeCommandRunResult,
  type RuntimeCommandSummary,
  type RuntimeConfigureParams,
  type RuntimeHealthSnapshot,
  type RuntimeInitializeParams,
  type RuntimeOverlayAutoPanelEventPayload,
  type RuntimeOverlayAutoPanelStartPayload,
  type RuntimePersonalWebsiteGenerationRequest,
  type RuntimeProjectDirectoryRegistrationResult,
  type RuntimeSelfModRevertResult,
  type RuntimeTaskRequest,
  type RuntimeTaskSnapshot,
  type RuntimeVoiceAgentEventPayload,
  type RuntimeVoiceChatPayload,
  type RuntimeVoiceHmrStatePayload,
  type RuntimeVoiceTranscriptPayload,
  type RuntimeWebSearchResult,
  type RunResumeEventsResult,
  type ScheduledConversationEvent,
  type SelfModBatchRecord,
  type SelfModFeatureSummary,
  type SelfModFeatureRecord,
  type SelfModHmrState,
  type SocialSessionServiceSnapshot,
  type StorePublishArgs,
  type StorePackageRecord,
  type StorePackageReleaseRecord,
  type StoreReleaseDraft,
} from "../runtime-protocol/index.js";
import { attachJsonRpcPeerToStreams } from "../runtime-protocol/jsonl.js";
import {
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "../runtime-protocol/rpc-peer.js";
import { fileURLToPath } from "node:url";

type RuntimeClientEvents = {
  "runtime-connected": void;
  "runtime-disconnected": { reason: string };
  "runtime-ready": RuntimeHealthSnapshot;
  "runtime-reloading": { reason: string };
  "runtime-lagged": { droppedCount: number };
  "run-event": RuntimeAgentEventPayload;
  "run-self-mod-hmr-state": { runId?: string; state: SelfModHmrState };
  "voice-agent-event": RuntimeVoiceAgentEventPayload;
  "voice-self-mod-hmr-state": RuntimeVoiceHmrStatePayload;
  "local-chat-updated": void;
  "schedule-updated": void;
  "projects-updated": LocalDevProjectRecord[];
  "overlay-auto-panel-event": RuntimeOverlayAutoPanelEventPayload;
  "capability-changed": { workerGeneration: number; sourcePaths: string[] };
};

export type RuntimeHostHandlers = {
  uiSnapshot: () => Promise<string>;
  uiAct: (params: HostUiActParams) => Promise<string>;
  getDeviceIdentity: () => Promise<HostDeviceIdentity>;
  signHeartbeatPayload: (signedAtMs: number) => Promise<HostHeartbeatSignature>;
  requestCredential: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  displayUpdate: (html: string) => Promise<void> | void;
  showNotification?: (payload: { title: string; body: string }) => Promise<void> | void;
  openExternal?: (url: string) => Promise<void> | void;
  showWindow?: (target: HostWindowTarget) => Promise<void> | void;
  focusWindow?: (target: HostWindowTarget) => Promise<void> | void;
  runHmrTransition?: (payload: {
    runId: string;
    requiresFullReload: boolean;
    resumeHmr: () => Promise<void>;
    reportState?: (state: SelfModHmrState) => Promise<void> | void;
  }) => Promise<void> | void;
};

export type StellaRuntimeClientOptions = {
  daemonEntryPath?: string;
  hostHandlers: RuntimeHostHandlers;
  initializeParams: Omit<RuntimeInitializeParams, "protocolVersion">;
};

const parseDisplayUpdateParams = (params: unknown): string => {
  if (typeof params === "string") {
    return params;
  }
  if (
    params &&
    typeof params === "object" &&
    "html" in params &&
    typeof (params as HostDisplayUpdateParams).html === "string"
  ) {
    return (params as HostDisplayUpdateParams).html;
  }
  throw new Error("Invalid host display update payload.");
};

export class StellaRuntimeClient {
  private readonly events = new EventEmitter();
  private process: ChildProcessWithoutNullStreams | null = null;
  private peer: JsonRpcPeer | null = null;
  private started = false;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private reloadQueue = Promise.resolve();
  private configCache: RuntimeConfigureParams = {};
  private daemonCrashCount = 0;
  private daemonLastConnectedAt: number | null = null;

  constructor(private readonly options: StellaRuntimeClientOptions) {}

  on<K extends keyof RuntimeClientEvents>(
    eventName: K,
    listener: (payload: RuntimeClientEvents[K]) => void,
  ): () => void {
    this.events.on(eventName, listener as (...args: unknown[]) => void);
    return () => {
      this.events.removeListener(eventName, listener as (...args: unknown[]) => void);
    };
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.spawnDaemon();
  }

  async stop() {
    this.started = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.daemonCrashCount = 0;
    this.daemonLastConnectedAt = null;
    const child = this.process;
    this.process = null;
    this.peer = null;
    this.events.emit("runtime-disconnected", {
      reason: "stopped",
    });
    if (!child) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", finish);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish();
      }, 1_500).unref();
    });
  }

  async restartDaemon() {
    const shouldRestart = this.started;
    await this.stop();
    if (shouldRestart) {
      this.started = true;
      await this.spawnDaemon();
    }
  }

  async configure(params: RuntimeConfigureParams) {
    this.configCache = {
      ...this.configCache,
      ...params,
    };
    return await this.request(METHOD_NAMES.RUNTIME_CONFIGURE, params);
  }

  async health(): Promise<RuntimeHealthSnapshot> {
    return await this.request<RuntimeHealthSnapshot>(METHOD_NAMES.RUNTIME_HEALTH);
  }

  async reloadCapabilities() {
    return await this.request(METHOD_NAMES.RUNTIME_RELOAD_CAPABILITIES);
  }

  async restartWorker() {
    return await this.request(METHOD_NAMES.RUNTIME_RESTART_WORKER);
  }

  async healthCheck() {
    return await this.request<AgentHealth | null>(METHOD_NAMES.RUN_HEALTH_CHECK);
  }

  async getActiveRun() {
    return await this.request<RuntimeActiveRun | null>(METHOD_NAMES.RUN_GET_ACTIVE);
  }

  async startChat(payload: RuntimeChatPayload) {
    return await this.request<{ runId: string }>(METHOD_NAMES.RUN_START_CHAT, payload);
  }

  async cancelChat(runId: string) {
    return await this.request(METHOD_NAMES.RUN_CANCEL, { runId });
  }

  async resumeRunEvents(payload: {
    runId: string;
    lastSeq: number;
  }): Promise<RunResumeEventsResult> {
    return await this.request<RunResumeEventsResult>(
      METHOD_NAMES.RUN_RESUME_EVENTS,
      payload,
    );
  }

  async runAutomationTurn(payload: RuntimeAutomationTurnRequest) {
    return await this.request<RuntimeAutomationTurnResult>(
      METHOD_NAMES.RUN_AUTOMATION,
      payload,
    );
  }

  async runBlockingLocalTask(payload: RuntimeTaskRequest) {
    return await this.request<
      | { status: "ok"; finalText: string; taskId: string }
      | { status: "error"; finalText: ""; error: string; taskId?: string }
    >(METHOD_NAMES.TASK_RUN_BLOCKING, payload);
  }

  async createBackgroundTask(payload: RuntimeTaskRequest) {
    return await this.request<{ taskId: string }>(
      METHOD_NAMES.TASK_CREATE_BACKGROUND,
      payload,
    );
  }

  async getLocalTaskSnapshot(taskId: string) {
    return await this.request<RuntimeTaskSnapshot | null>(
      METHOD_NAMES.TASK_GET_SNAPSHOT,
      { taskId },
    );
  }

  async appendThreadMessage(args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) {
    return await this.request(METHOD_NAMES.THREAD_APPEND_MESSAGE, args);
  }

  async webSearch(query: string, options?: { category?: string; displayResults?: boolean }) {
    return await this.request<RuntimeWebSearchResult>(METHOD_NAMES.SEARCH_WEB, {
      query,
      ...options,
    });
  }

  async persistVoiceTranscript(payload: RuntimeVoiceTranscriptPayload) {
    return await this.request<{ ok: true }>(
      METHOD_NAMES.VOICE_PERSIST_TRANSCRIPT,
      payload,
    );
  }

  async voiceOrchestratorChat(payload: RuntimeVoiceChatPayload) {
    return await this.request<string>(METHOD_NAMES.VOICE_ORCHESTRATOR_CHAT, payload);
  }

  async voiceWebSearch(payload: { query: string; category?: string }) {
    return await this.request<RuntimeWebSearchResult>(METHOD_NAMES.VOICE_WEB_SEARCH, payload);
  }

  async getOrCreateDefaultConversationId() {
    return await this.request<string>(METHOD_NAMES.LOCAL_CHAT_GET_OR_CREATE_DEFAULT);
  }

  async listLocalChatEvents(payload: { conversationId: string; maxItems?: number }) {
    return await this.request<Array<Record<string, unknown>>>(
      METHOD_NAMES.LOCAL_CHAT_LIST_EVENTS,
      payload,
    );
  }

  async getLocalChatEventCount(payload: { conversationId: string }) {
    return await this.request<number>(METHOD_NAMES.LOCAL_CHAT_GET_EVENT_COUNT, payload);
  }

  async appendLocalChatEvent(payload: Record<string, unknown>) {
    return await this.request<Record<string, unknown>>(
      METHOD_NAMES.LOCAL_CHAT_APPEND_EVENT,
      payload,
    );
  }

  async listLocalChatSyncMessages(payload: {
    conversationId: string;
    maxMessages?: number;
  }) {
    return await this.request<Array<Record<string, unknown>>>(
      METHOD_NAMES.LOCAL_CHAT_LIST_SYNC_MESSAGES,
      payload,
    );
  }

  async getLocalChatSyncCheckpoint(payload: { conversationId: string }) {
    return await this.request<string | null>(
      METHOD_NAMES.LOCAL_CHAT_GET_SYNC_CHECKPOINT,
      payload,
    );
  }

  async setLocalChatSyncCheckpoint(payload: {
    conversationId: string;
    localMessageId: string;
  }) {
    return await this.request<{ ok: true }>(
      METHOD_NAMES.LOCAL_CHAT_SET_SYNC_CHECKPOINT,
      payload,
    );
  }

  async listLocalFeatures(limit?: number) {
    return await this.request<SelfModFeatureRecord[]>(
      METHOD_NAMES.STORE_MODS_LIST_FEATURES,
      { limit },
    );
  }

  async listFeatureBatches(featureId: string) {
    return await this.request<SelfModBatchRecord[]>(
      METHOD_NAMES.STORE_MODS_LIST_BATCHES,
      { featureId },
    );
  }

  async createReleaseDraft(payload: { featureId: string; batchIds?: string[] }) {
    return await this.request<StoreReleaseDraft>(
      METHOD_NAMES.STORE_MODS_CREATE_RELEASE_DRAFT,
      payload,
    );
  }

  async listInstalledMods() {
    return await this.request<InstalledStoreModRecord[]>(
      METHOD_NAMES.STORE_MODS_LIST_INSTALLED,
    );
  }

  async listStorePackages() {
    return await this.request<StorePackageRecord[]>(METHOD_NAMES.STORE_LIST_PACKAGES);
  }

  async getStorePackage(packageId: string) {
    return await this.request<StorePackageRecord | null>(
      METHOD_NAMES.STORE_GET_PACKAGE,
      { packageId },
    );
  }

  async listStorePackageReleases(packageId: string) {
    return await this.request<StorePackageReleaseRecord[]>(
      METHOD_NAMES.STORE_LIST_RELEASES,
      { packageId },
    );
  }

  async getStorePackageRelease(packageId: string, releaseNumber: number) {
    return await this.request<StorePackageReleaseRecord | null>(
      METHOD_NAMES.STORE_GET_RELEASE,
      { packageId, releaseNumber },
    );
  }

  async createFirstStoreRelease(args: StorePublishArgs) {
    return await this.request<StorePackageReleaseRecord>(
      METHOD_NAMES.STORE_CREATE_FIRST_RELEASE,
      args,
    );
  }

  async createStoreReleaseUpdate(args: StorePublishArgs) {
    return await this.request<StorePackageReleaseRecord>(
      METHOD_NAMES.STORE_CREATE_RELEASE_UPDATE,
      args,
    );
  }

  async publishStoreRelease(payload: {
    featureId: string;
    batchIds?: string[];
    packageId?: string;
    displayName?: string;
    description?: string;
    releaseNotes?: string;
  }) {
    return await this.request<StorePackageReleaseRecord>(
      METHOD_NAMES.STORE_PUBLISH_RELEASE,
      payload,
    );
  }

  async installStoreRelease(payload: { packageId: string; releaseNumber?: number }) {
    return await this.request<InstalledStoreModRecord>(
      METHOD_NAMES.STORE_INSTALL_RELEASE,
      payload,
    );
  }

  async uninstallStoreMod(packageId: string) {
    return await this.request<{ packageId: string; revertedCommits: string[] }>(
      METHOD_NAMES.STORE_UNINSTALL_MOD,
      { packageId },
    );
  }

  async listCronJobs() {
    return await this.request<LocalCronJobRecord[]>(METHOD_NAMES.SCHEDULE_LIST_CRON_JOBS);
  }

  async listHeartbeats() {
    return await this.request<LocalHeartbeatConfigRecord[]>(
      METHOD_NAMES.SCHEDULE_LIST_HEARTBEATS,
    );
  }

  async listConversationEvents(payload: { conversationId: string; maxItems?: number }) {
    return await this.request<ScheduledConversationEvent[]>(
      METHOD_NAMES.SCHEDULE_LIST_EVENTS,
      payload,
    );
  }

  async getConversationEventCount(payload: { conversationId: string }) {
    return await this.request<number>(METHOD_NAMES.SCHEDULE_GET_EVENT_COUNT, payload);
  }

  async getSocialSessionStatus() {
    return await this.request<SocialSessionServiceSnapshot>(
      METHOD_NAMES.SOCIAL_SESSIONS_GET_STATUS,
    );
  }

  async listProjects() {
    return await this.request<LocalDevProjectRecord[]>(METHOD_NAMES.PROJECTS_LIST);
  }

  async registerProjectDirectory(projectPath: string) {
    return await this.request<RuntimeProjectDirectoryRegistrationResult>(
      METHOD_NAMES.PROJECTS_REGISTER_DIRECTORY,
      { projectPath },
    );
  }

  async startProject(projectId: string) {
    return await this.request<LocalDevProjectRecord[]>(METHOD_NAMES.PROJECTS_START, {
      projectId,
    });
  }

  async stopProject(projectId: string) {
    return await this.request<LocalDevProjectRecord[]>(METHOD_NAMES.PROJECTS_STOP, {
      projectId,
    });
  }

  async startOverlayAutoPanelStream(payload: RuntimeOverlayAutoPanelStartPayload) {
    return await this.request<{ ok: true }>(METHOD_NAMES.OVERLAY_AUTO_PANEL_START, payload);
  }

  async cancelOverlayAutoPanelStream(requestId: string) {
    return await this.request<{ ok: true }>(METHOD_NAMES.OVERLAY_AUTO_PANEL_CANCEL, {
      requestId,
    });
  }

  async startPersonalWebsiteGeneration(payload: RuntimePersonalWebsiteGenerationRequest) {
    return await this.request<void>(
      METHOD_NAMES.DASHBOARD_START_PERSONAL_WEBSITE_GENERATION,
      payload,
    );
  }

  async revertSelfModFeature(payload: { featureId?: string; steps?: number }) {
    return await this.request<RuntimeSelfModRevertResult>(
      METHOD_NAMES.SELF_MOD_REVERT,
      payload,
    );
  }

  async getLastSelfModFeature() {
    return await this.request<string | null>(METHOD_NAMES.SELF_MOD_LAST_FEATURE);
  }

  async listRecentSelfModFeatures(limit?: number) {
    return await this.request<SelfModFeatureSummary[]>(
      METHOD_NAMES.SELF_MOD_RECENT_FEATURES,
      { limit },
    );
  }

  async killAllShells() {
    return await this.request(METHOD_NAMES.SHELL_KILL_ALL);
  }

  async killShellsByPort(port: number) {
    return await this.request(METHOD_NAMES.SHELL_KILL_BY_PORT, { port });
  }

  async listCommands() {
    return await this.request<RuntimeCommandSummary[]>(METHOD_NAMES.COMMAND_LIST);
  }

  async runCommand(params: RuntimeCommandRunParams) {
    return await this.request<RuntimeCommandRunResult>(METHOD_NAMES.COMMAND_RUN, params);
  }

  private async spawnDaemon() {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const daemonEntryPath = this.options.daemonEntryPath ?? resolveDefaultDaemonEntryPath();
    const child = spawn(process.execPath, [daemonEntryPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    const { peer } = attachJsonRpcPeerToStreams({
      input: child.stdout,
      output: child.stdin,
      onError: (error) => {
        console.error("[runtime-client] RPC error:", error);
      },
    });
    this.peer = peer;
    this.registerHostHandlers(peer);
    this.registerNotifications(peer);

    child.once("exit", () => {
      this.process = null;
      this.peer = null;
      this.events.emit("runtime-disconnected", {
        reason: "daemon-exit",
      });
      if (!this.started) {
        return;
      }
      const now = Date.now();
      if (
        this.daemonLastConnectedAt !== null &&
        now - this.daemonLastConnectedAt >= 10_000
      ) {
        this.daemonCrashCount = 0;
      }
      const delayMs = Math.min(250 * 2 ** this.daemonCrashCount, 5_000);
      this.daemonCrashCount = Math.min(this.daemonCrashCount + 1, 5);
      this.events.emit("runtime-reloading", {
        reason: `daemon-restart:${delayMs}`,
      });
      if (this.respawnTimer) {
        clearTimeout(this.respawnTimer);
      }
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        if (this.started && !this.process) {
          void this.spawnDaemon().catch((error) => {
            console.error("[runtime-client] Failed to respawn daemon:", error);
          });
        }
      }, delayMs);
      this.respawnTimer.unref?.();
    });

    await this.request(METHOD_NAMES.INITIALIZE, {
      ...this.options.initializeParams,
      protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
    } satisfies RuntimeInitializeParams);
    await this.request(METHOD_NAMES.INITIALIZED, {});
    if (Object.keys(this.configCache).length > 0) {
      await this.request(METHOD_NAMES.RUNTIME_CONFIGURE, this.configCache);
    }
    this.daemonLastConnectedAt = Date.now();
    this.events.emit("runtime-connected", undefined);
    this.events.emit("runtime-ready", await this.health());
    this.startDevWatcher(daemonEntryPath);
  }

  private registerHostHandlers(peer: JsonRpcPeer) {
    peer.registerRequestHandler(METHOD_NAMES.HOST_UI_SNAPSHOT, async () => {
      return await this.options.hostHandlers.uiSnapshot();
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_UI_ACT, async (params) => {
      return await this.options.hostHandlers.uiAct(params as HostUiActParams);
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_IDENTITY_GET, async () => {
      return await this.options.hostHandlers.getDeviceIdentity();
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
        params as { title: string; body: string },
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
    peer.registerRequestHandler(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, async (params) => {
      const payload = params as { runId?: string; requiresFullReload?: boolean };
      if (!payload.runId) {
        throw new Error("HOST_HMR_RUN_TRANSITION requires a runId.");
      }
      await this.options.hostHandlers.runHmrTransition?.({
        runId: payload.runId,
        requiresFullReload: Boolean(payload.requiresFullReload),
        resumeHmr: async () => {
          await this.request(METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR, {
            runId: payload.runId,
          });
        },
        reportState: async (state) => {
          this.events.emit("run-self-mod-hmr-state", {
            runId: payload.runId,
            state,
          });
        },
      });
      return { ok: true };
    });
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
      this.events.emit("run-event", params as RuntimeAgentEventPayload);
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
      NOTIFICATION_NAMES.VOICE_SELF_MOD_HMR_STATE,
      (params) => {
        this.events.emit(
          "voice-self-mod-hmr-state",
          params as RuntimeVoiceHmrStatePayload,
        );
      },
    );
    peer.registerNotificationHandler(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, () => {
      this.events.emit("local-chat-updated", undefined);
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.SCHEDULE_UPDATED, () => {
      this.events.emit("schedule-updated", undefined);
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.PROJECTS_UPDATED, (params) => {
      this.events.emit("projects-updated", params as LocalDevProjectRecord[]);
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.OVERLAY_AUTO_PANEL_EVENT, (params) => {
      this.events.emit(
        "overlay-auto-panel-event",
        params as RuntimeOverlayAutoPanelEventPayload,
      );
    });
    peer.registerNotificationHandler(NOTIFICATION_NAMES.CAPABILITY_CHANGED, (params) => {
      this.events.emit(
        "capability-changed",
        params as { workerGeneration: number; sourcePaths: string[] },
      );
    });
  }

  private async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (!this.peer) {
      throw createRuntimeUnavailableError("Stella runtime client is not connected.");
    }
    return await this.peer.request<TResult>(method, params);
  }

  private startDevWatcher(daemonEntryPath: string) {
    if (!this.options.initializeParams.isDev || this.watcher) {
      return;
    }
    const distElectronRoot = path.resolve(
      path.dirname(daemonEntryPath),
      "..",
      "..",
      "..",
    );
    this.watcher = watch(
      distElectronRoot,
      { recursive: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !filename.endsWith(".js")) {
          return;
        }
        const normalized = filename.replace(/\\/g, "/");
        const action = classifyRuntimeReload(normalized);
        if (!action) {
          return;
        }
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reloadQueue = this.reloadQueue
            .catch(() => undefined)
            .then(async () => {
              if (action === "capabilities") {
                await this.reloadCapabilities();
                return;
              }
              if (action === "worker") {
                await this.restartWorker();
                return;
              }
              await this.restartDaemon();
            });
        }, 150);
      },
    );
  }
}

const resolveDefaultDaemonEntryPath = () =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "runtime-daemon",
    "entry.js",
  );

const classifyRuntimeReload = (
  normalizedFilename: string,
): "capabilities" | "worker" | "daemon" | null => {
  if (
    normalizedFilename.startsWith("packages/runtime-capabilities/") ||
    normalizedFilename.startsWith("resources/bundled-commands/")
  ) {
    return "capabilities";
  }
  if (
    normalizedFilename.startsWith("packages/runtime-worker/") ||
    normalizedFilename.startsWith("packages/ai/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/agent-core/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/") ||
    normalizedFilename.startsWith("packages/runtime-discovery/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/home/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/dev-projects/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/cli/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/self-mod/") ||
    normalizedFilename.startsWith("packages/runtime-kernel/storage/")
  ) {
    return "worker";
  }
  if (
    normalizedFilename.startsWith("packages/runtime-daemon/") ||
    normalizedFilename.startsWith("packages/runtime-protocol/") ||
    normalizedFilename.startsWith("packages/runtime-client/")
  ) {
    return "daemon";
  }
  return null;
};
