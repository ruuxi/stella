import { EventEmitter } from "node:events";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DevProjectService } from "../kernel/dev-projects/dev-project-service.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import type {
  LocalCronJobCreateInput,
  LocalCronJobUpdatePatch,
  LocalHeartbeatUpsertInput,
} from "../kernel/shared/scheduling.js";
import { createDesktopDatabase } from "../kernel/storage/database-node.js";
import { ChatStore } from "../kernel/storage/chat-store.js";
import { StoreModStore } from "../kernel/storage/store-mod-store.js";
import { TranscriptMirror } from "../kernel/storage/transcript-mirror.js";
import { prepareStoredLocalChatPayload } from "../kernel/storage/local-chat-payload.js";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import type {
  DiscoveryKnowledgeSeedPayload,
} from "../../src/shared/contracts/discovery.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type HostDeviceIdentity,
  type HostDisplayUpdateParams,
  type HostHeartbeatSignature,
  type HostUiActParams,
  type HostWindowTarget,
  type InstalledStoreModRecord,
  type LocalCronJobRecord,
  type LocalDevProjectRecord,
  type LocalHeartbeatConfigRecord,
  type RuntimeAgentEventPayload,
  type RuntimeAutomationTurnRequest,
  type RuntimeAutomationTurnResult,
  type RuntimeChatPayload,
  type RuntimeConfigureParams,
  type RuntimeHealthSnapshot,
  type RuntimeProjectDirectoryRegistrationResult,
  type RuntimeSocialSessionStatus,
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
  type SelfModFeatureSummary,
  type SelfModHmrState,
  type SocialSessionServiceSnapshot,
  type StorePackageRecord,
  type StorePackageReleaseRecord,
  type StorePublishArgs,
  type StoreReleaseDraft,
  type RuntimeInitializeParams,
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
  "google-workspace-auth-required": void;
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
    resumeHmr: (
      options?: { suppressClientFullReload?: boolean },
    ) => Promise<void>;
    reportState?: (state: SelfModHmrState) => Promise<void> | void;
  }) => Promise<void> | void;
};

export type StellaRuntimeClientOptions = {
  workerEntryPath?: string;
  hostHandlers: RuntimeHostHandlers;
  initializeParams: Omit<RuntimeInitializeParams, "protocolVersion">;
};

type WorkerInitializationState = {
  stellaHomePath: string;
  stellaWorkspacePath: string;
  frontendRoot: string;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  hasConnectedAccount: boolean;
  cloudSyncEnabled: boolean;
};

const AGENT_EVENT_BUFFER_LIMIT = 1_000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1_000;
const SELF_MOD_RUNTIME_RELOAD_STATE_FILE = ".stella-runtime-reload-state.json";

type RuntimeReloadAction = "worker";

const mergeRuntimeReloadAction = (
  _current: RuntimeReloadAction | null,
  _next: RuntimeReloadAction,
): RuntimeReloadAction => "worker";

const parseDisplayUpdateParams = (params: unknown): string => {
  if (typeof params === "string") return params;
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

const buildDefaultSocialSessionSnapshot = (): SocialSessionServiceSnapshot => ({
  enabled: false,
  status: "stopped",
  sessionCount: 0,
  sessions: [],
});

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

export class StellaRuntimeClient {
  private readonly events = new EventEmitter();
  private readonly agentEventBuffers = new Map<
    string,
    { events: RuntimeAgentEventPayload[]; updatedAt: number }
  >();
  private readonly workerController: RuntimeWorkerLifecycleController;
  private workerHealthCache: WorkerHealthSnapshot | null = null;
  private hostDb: SqliteDatabase | null = null;
  private hostChatStore: ChatStore | null = null;
  private hostStoreModStore: StoreModStore | null = null;
  private schedulerService: LocalSchedulerService | null = null;
  private schedulerSubscription: (() => void) | null = null;
  private projectService: DevProjectService | null = null;
  private projectSubscription: (() => void) | null = null;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private scheduledRuntimeReloadAction: RuntimeReloadAction | null = null;
  private deferredRuntimeReloadAction: RuntimeReloadAction | null = null;
  private readonly pausedRuntimeReloadRuns = new Set<string>();
  private reloadQueue = Promise.resolve();
  private configCache: RuntimeConfigureParams = {};
  private deviceIdentity: HostDeviceIdentity | null = null;
  private workerGeneration = 0;
  private started = false;
  private hostReady = false;

  constructor(private readonly options: StellaRuntimeClientOptions) {
    this.workerController = new RuntimeWorkerLifecycleController({
      workerEntryPath: resolveDefaultWorkerEntryPath(this.options),
      isHostStarted: () => this.started,
      initializeConnection: async (connection) => {
        this.registerHostHandlers(connection.peer);
        this.registerNotifications(connection.peer);
        await connection.peer.request(
          METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
          this.buildWorkerInitializationState(),
        );
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
    });
  }

  private getRuntimeReloadStateFilePath() {
    return path.join(
      this.options.initializeParams.frontendRoot,
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

  private async resumeRuntimeReloads(runId: string) {
    this.pausedRuntimeReloadRuns.delete(runId);
    await this.persistRuntimeReloadPauseState();
    if (this.pausedRuntimeReloadRuns.size > 0) {
      return;
    }
    const deferredAction = this.deferredRuntimeReloadAction;
    this.deferredRuntimeReloadAction = null;
    if (!deferredAction) {
      return;
    }
    setTimeout(() => {
      void this.scheduleRuntimeReload(deferredAction);
    }, 0);
  }

  private async applyRuntimeReload(_action: RuntimeReloadAction) {
    await this.restartWorker();
  }

  private async scheduleRuntimeReload(action: RuntimeReloadAction) {
    if (this.pausedRuntimeReloadRuns.size > 0) {
      this.deferredRuntimeReloadAction = mergeRuntimeReloadAction(
        this.deferredRuntimeReloadAction,
        action,
      );
      return;
    }
    this.scheduledRuntimeReloadAction = mergeRuntimeReloadAction(
      this.scheduledRuntimeReloadAction,
      action,
    );
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      const scheduledAction = this.scheduledRuntimeReloadAction;
      this.reloadTimer = null;
      this.scheduledRuntimeReloadAction = null;
      if (!scheduledAction) {
        return;
      }
      this.reloadQueue = this.reloadQueue
        .catch(() => undefined)
        .then(async () => {
          await this.applyRuntimeReload(scheduledAction);
        });
    }, 150);
  }

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
    if (this.started) return;
    this.started = true;
    await this.persistRuntimeReloadPauseState();
    await this.initializeHostServices();
    this.events.emit("runtime-connected", undefined);
    this.events.emit("runtime-ready", await this.health());
    this.startDevWatcher(resolveDefaultWorkerEntryPath(this.options));
    // Eagerly start the worker so the remote turn bridge subscription is active
    void this.workerController.ensureStarted().catch(() => {});
  }

  async stop() {
    this.started = false;
    this.hostReady = false;
    this.deviceIdentity = null;
    this.configCache = {};
    this.workerHealthCache = null;
    this.workerGeneration = 0;
    this.agentEventBuffers.clear();
    this.pausedRuntimeReloadRuns.clear();
    this.deferredRuntimeReloadAction = null;
    this.scheduledRuntimeReloadAction = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.persistRuntimeReloadPauseState().catch(() => undefined);
    await this.workerController.stop("stopped");
    await this.stopHostServices();
    this.events.emit("runtime-disconnected", { reason: "stopped" });
  }

  async configure(params: RuntimeConfigureParams) {
    this.configCache = { ...this.configCache, ...params };
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

  async healthCheck() {
    const health = await this.getWorkerHealth({ ensureWorker: false });
    return health?.health ?? null;
  }

  async getActiveRun() {
    const health = await this.getWorkerHealth({ ensureWorker: false });
    return health?.activeRun ?? null;
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
    const buffer = this.agentEventBuffers.get(payload.runId);
    if (!buffer) {
      return { events: [], exhausted: true };
    }
    const oldestSeq = buffer.events[0]?.seq ?? null;
    const exhausted = oldestSeq !== null && payload.lastSeq < oldestSeq - 1;
    return {
      events: buffer.events.filter((event) => event.seq > payload.lastSeq),
      exhausted,
    };
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

  async runBlockingLocalTask(payload: RuntimeTaskRequest) {
    return await this.requestWorker<
      | { status: "ok"; finalText: string; taskId: string }
      | { status: "error"; finalText: ""; error: string; taskId?: string }
    >(METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_TASK, payload, {
      ensureWorker: true,
      recordActivity: true,
    });
  }

  async createBackgroundTask(payload: RuntimeTaskRequest) {
    return await this.requestWorker<{ taskId: string }>(
      METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_TASK,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async getLocalTaskSnapshot(taskId: string) {
    return await this.requestWorker<RuntimeTaskSnapshot | null>(
      METHOD_NAMES.INTERNAL_WORKER_GET_TASK_SNAPSHOT,
      { taskId },
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

  async webSearch(query: string, options?: { category?: string; displayResults?: boolean }) {
    return await this.requestWorker<RuntimeWebSearchResult>(
      METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH,
      { query, ...options },
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
    return this.ensureHostChatStore().getOrCreateDefaultConversationId();
  }

  async listLocalChatEvents(payload: { conversationId: string; maxItems?: number }) {
    return this.ensureHostChatStore().listEvents(
      payload.conversationId,
      payload.maxItems,
    );
  }

  async getLocalChatEventCount(payload: { conversationId: string }) {
    return this.ensureHostChatStore().getEventCount(payload.conversationId);
  }

  async persistDiscoveryWelcome(payload: {
    conversationId: string;
    message: string;
    suggestions?: unknown[];
  }) {
    const store = this.ensureHostChatStore();
    const message = typeof payload.message === "string" ? payload.message : "";
    if (message.trim().length > 0) {
      store.appendEvent({
        conversationId: payload.conversationId,
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
      store.appendEvent({
        conversationId: payload.conversationId,
        type: "home_suggestions",
        payload: { suggestions },
      });
    }
    this.events.emit("local-chat-updated", undefined);
    return { ok: true as const };
  }

  async listLocalChatSyncMessages(payload: {
    conversationId: string;
    maxMessages?: number;
  }) {
    return this.ensureHostChatStore().listSyncMessages(
      payload.conversationId,
      payload.maxMessages,
    );
  }

  async getLocalChatSyncCheckpoint(payload: { conversationId: string }) {
    return this.ensureHostChatStore().getSyncCheckpoint(payload.conversationId);
  }

  async setLocalChatSyncCheckpoint(payload: {
    conversationId: string;
    localMessageId: string;
  }) {
    this.ensureHostChatStore().setSyncCheckpoint(
      payload.conversationId,
      payload.localMessageId,
    );
    return { ok: true as const };
  }

  async listLocalFeatures(limit?: number) {
    const features = this.ensureHostStoreModStore().listFeatures();
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return features;
    }
    return features.slice(0, Math.max(0, Math.floor(limit)));
  }

  async listFeatureBatches(featureId: string) {
    return this.ensureHostStoreModStore().listBatches(featureId);
  }

  async createReleaseDraft(payload: { featureId: string; batchIds?: string[] }) {
    return await this.requestWorker<StoreReleaseDraft>(
      METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_CREATE_RELEASE_DRAFT,
      payload,
      { ensureWorker: true, recordActivity: true },
    );
  }

  async listInstalledMods() {
    return this.ensureHostStoreModStore().listInstalledMods();
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

  async publishStoreRelease(payload: {
    featureId: string;
    batchIds?: string[];
    packageId?: string;
    displayName?: string;
    description?: string;
    releaseNotes?: string;
  }) {
    return await this.requestWorker<StorePackageReleaseRecord>(
      METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_RELEASE,
      payload,
      {
        ensureWorker: true,
        recordActivity: true,
      },
    );
  }

  async installStoreRelease(payload: { packageId: string; releaseNumber?: number }) {
    return await this.requestWorker<InstalledStoreModRecord>(
      METHOD_NAMES.INTERNAL_WORKER_INSTALL_STORE_RELEASE,
      payload,
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

  async listCronJobs(): Promise<LocalCronJobRecord[]> {
    return this.ensureScheduler().listCronJobs();
  }

  async listHeartbeats(): Promise<LocalHeartbeatConfigRecord[]> {
    return this.ensureScheduler().listHeartbeats();
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
    return health?.socialSessions ?? buildDefaultSocialSessionSnapshot();
  }

  async listProjects() {
    return await this.ensureProjectService().listProjects();
  }

  async registerProjectDirectory(
    projectPath: string,
  ): Promise<RuntimeProjectDirectoryRegistrationResult> {
    return await this.ensureProjectService().pickProjectDirectory(projectPath);
  }

  async startProject(projectId: string) {
    return await this.ensureProjectService().startProject(projectId);
  }

  async stopProject(projectId: string) {
    return await this.ensureProjectService().stopProject(projectId);
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
    return await coreMemoryExists(this.options.initializeParams.stellaHomePath);
  }

  async discoveryKnowledgeExists() {
    const { discoveryKnowledgeExists } = await import(
      "../discovery/life-knowledge.js"
    );
    return await discoveryKnowledgeExists(this.options.initializeParams.stellaHomePath);
  }

  async writeCoreMemory(content: string) {
    const { writeCoreMemory } = await import("../discovery/browser-data.js");
    await writeCoreMemory(this.options.initializeParams.stellaHomePath, content);
  }

  async writeDiscoveryKnowledge(payload: DiscoveryKnowledgeSeedPayload) {
    const { writeDiscoveryKnowledge } = await import(
      "../discovery/life-knowledge.js"
    );
    await writeDiscoveryKnowledge(this.options.initializeParams.stellaHomePath, payload);
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

  private ensureProjectService() {
    if (!this.projectService) {
      throw createRuntimeUnavailableError("Dev project service is not available.");
    }
    return this.projectService;
  }

  private ensureHostChatStore() {
    if (!this.hostChatStore) {
      throw createRuntimeUnavailableError("Host chat store is not available.");
    }
    return this.hostChatStore;
  }

  private ensureHostStoreModStore() {
    if (!this.hostStoreModStore) {
      throw createRuntimeUnavailableError("Host store mod store is not available.");
    }
    return this.hostStoreModStore;
  }

  private async initializeHostServices() {
    await this.stopHostServices();
    this.deviceIdentity = await this.options.hostHandlers.getDeviceIdentity();

    const stellaHome = this.options.initializeParams.stellaHomePath;
    const db = createDesktopDatabase(stellaHome);
    this.hostDb = db;
    const mirror = new TranscriptMirror(path.join(stellaHome, "state"));
    this.hostChatStore = new ChatStore(db, mirror);
    this.hostStoreModStore = new StoreModStore(db);

    const scheduler = new LocalSchedulerService({
      stellaHome: this.options.initializeParams.stellaHomePath,
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
    });
    scheduler.start();
    this.schedulerService = scheduler;
    this.schedulerSubscription = scheduler.subscribe(() => {
      this.events.emit("schedule-updated", undefined);
    });

    const projects = new DevProjectService({
      getStellaHomePath: () => this.options.initializeParams.stellaHomePath,
    });
    this.projectService = projects;
    this.projectSubscription = projects.subscribe(() => {
      void this.emitProjectsUpdated();
    });

    this.hostReady = true;
  }

  private async stopHostServices() {
    this.projectSubscription?.();
    this.projectSubscription = null;
    await this.projectService?.stopAll();
    this.projectService = null;
    this.schedulerSubscription?.();
    this.schedulerSubscription = null;
    this.schedulerService?.stop();
    this.schedulerService = null;
    this.hostChatStore = null;
    this.hostStoreModStore = null;
    this.hostDb?.close();
    this.hostDb = null;
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

  private async emitProjectsUpdated() {
    if (!this.projectService) return;
    this.events.emit("projects-updated", await this.projectService.listProjects());
  }

  private buildWorkerInitializationState(): WorkerInitializationState {
    return {
      stellaHomePath: this.options.initializeParams.stellaHomePath,
      stellaWorkspacePath: this.options.initializeParams.stellaWorkspacePath,
      frontendRoot: this.options.initializeParams.frontendRoot,
      authToken: this.configCache.authToken ?? null,
      convexUrl: this.configCache.convexUrl ?? null,
      convexSiteUrl: this.configCache.convexSiteUrl ?? null,
      hasConnectedAccount: this.configCache.hasConnectedAccount ?? false,
      cloudSyncEnabled: this.configCache.cloudSyncEnabled ?? false,
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
      activeTaskCount: workerHealth?.activeTaskCount ?? 0,
    };
  }

  private registerHostHandlers(peer: JsonRpcPeer) {
    peer.registerRequestHandler(METHOD_NAMES.HOST_UI_SNAPSHOT, async () => {
      return await this.options.hostHandlers.uiSnapshot();
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_UI_ACT, async (params) => {
      return await this.options.hostHandlers.uiAct(params as HostUiActParams);
    });
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
    peer.registerRequestHandler(METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE, async (params) => {
      const payload = params as { runId?: string };
      if (!payload.runId) {
        throw new Error("HOST_RUNTIME_RELOAD_PAUSE requires a runId.");
      }
      await this.pauseRuntimeReloads(payload.runId);
      return { ok: true };
    });
    peer.registerRequestHandler(METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME, async (params) => {
      const payload = params as { runId?: string };
      if (!payload.runId) {
        throw new Error("HOST_RUNTIME_RELOAD_RESUME requires a runId.");
      }
      await this.resumeRuntimeReloads(payload.runId);
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
        resumeHmr: async (options) => {
          await this.requestWorker(
            METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR,
            {
              runId: payload.runId,
              ...(options ? { options } : {}),
            },
            { ensureWorker: false, recordActivity: true },
          );
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
      const action = classifyRuntimeReload(filename.replace(/\\/g, "/"));
      if (!action) return;
      void this.scheduleRuntimeReload(action);
    });
  }
}

const resolveDefaultWorkerEntryPath = (options: StellaRuntimeClientOptions) =>
  options.workerEntryPath ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "worker",
    "entry.js",
  );

const classifyRuntimeReload = (
  normalizedFilename: string,
): "worker" | null => {
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
    return "worker";
  }
  if (
    normalizedFilename.startsWith("runtime/kernel/") &&
    !hostOwnedRuntimeKernelPrefixes.some((prefix) =>
      normalizedFilename.startsWith(prefix),
    )
  ) {
    return "worker";
  }
  if (
    normalizedFilename.startsWith("runtime/ai/") ||
    normalizedFilename.startsWith("runtime/worker/") ||
    normalizedFilename.startsWith("runtime/protocol/jsonl")
  ) {
    return "worker";
  }
  return null;
};
