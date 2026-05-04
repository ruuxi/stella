import type { SelfModHmrState } from "../src/shared/contracts/boundary.js";
import type { DiscoveryKnowledgeSeedPayload } from "../src/shared/contracts/discovery.js";
import {
  AGENT_STREAM_EVENT_TYPES,
  isTaskLifecycleEventType,
  isTaskLifecycleTerminalType,
} from "../src/shared/contracts/agent-runtime.js";
import type {
  RuntimeActiveRun,
  RuntimeAgentEventPayload,
  RuntimeAutomationTurnRequest,
  RuntimeHealthSnapshot,
  RuntimeSocialSessionStatus,
  RuntimeVoiceActionCompletedPayload,
  RuntimeVoiceChatPayload,
  SelfModFeatureSummary,
  StorePublishArgs,
  StorePublishBlueprintArgs,
} from "../../runtime/protocol/index.js";
import {
  StellaRuntimeClient,
  type StellaRuntimeClientOptions,
} from "../../runtime/client/index.js";
import { createRuntimeUnavailableError } from "../../runtime/protocol/rpc-peer.js";
import type { AgentLifecycleEvent } from "../../runtime/kernel/agents/local-agent-manager.js";
import { readConfiguredStellaSiteUrl } from "../../runtime/kernel/convex-urls.js";

type AgentCallbacks = {
  onRunStarted?: (event: RuntimeAgentEventPayload) => void;
  onRunFinished: (event: RuntimeAgentEventPayload) => void;
  onStream: (event: RuntimeAgentEventPayload) => void;
  onAgentReasoning?: (event: RuntimeAgentEventPayload) => void;
  onStatus?: (event: RuntimeAgentEventPayload) => void;
  onToolStart: (event: RuntimeAgentEventPayload) => void;
  onToolEnd: (event: RuntimeAgentEventPayload) => void;
  onAgentEvent?: (event: AgentLifecycleEvent) => void;
  onSelfModHmrState?: (event: SelfModHmrState) => void;
};

export type RuntimeAvailabilitySnapshot = {
  connected: boolean;
  ready: boolean;
  reason?: string;
};

const isRunTerminalEvent = (type: string) =>
  type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED;

const isTaskScopedEvent = (type: string) =>
  type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING ||
  isTaskLifecycleEventType(type);

const LOCAL_CHAT_SESSION_IDLE_CLEANUP_MS = 30_000;

type LocalChatSession = {
  requestId: string;
  conversationId: string;
  callbacks: AgentCallbacks;
  knownRunIds: Set<string>;
  activeRunIds: Set<string>;
  activeTaskIds: Set<string>;
  lastSeqByScope: Map<string, number>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

export class RuntimeClientAdapter {
  readonly client: StellaRuntimeClient;
  private lastHealth:
    | { ready: boolean; reason?: string; runnerVersion?: string; engine?: string }
    | null = null;
  private lastRuntimeHealth: RuntimeHealthSnapshot | null = null;
  private activeRun: RuntimeActiveRun | null = null;
  private connected = false;
  private started = false;
  private lastConfigureError: string | null = null;
  private lastAvailabilitySnapshot: RuntimeAvailabilitySnapshot | null = null;
  private pendingConfig: {
    convexUrl?: string | null;
    convexSiteUrl?: string | null;
    authToken?: string | null;
    hasConnectedAccount?: boolean;
    cloudSyncEnabled?: boolean;
  } = {};
  private queuedConfigPatch: {
    convexUrl?: string | null;
    convexSiteUrl?: string | null;
    authToken?: string | null;
    hasConnectedAccount?: boolean;
    cloudSyncEnabled?: boolean;
  } = {};
  private configFlushQueued = false;
  private readonly localChatSessions = new Map<string, LocalChatSession>();
  private readonly availabilityListeners = new Set<
    (snapshot: RuntimeAvailabilitySnapshot) => void
  >();

  constructor(options: StellaRuntimeClientOptions) {
    this.client = new StellaRuntimeClient(options);
    this.client.on("runtime-connected", () => {
      this.connected = true;
      if (this.lastHealth && !this.lastHealth.ready) {
        this.lastHealth = { ready: false };
      }
      this.emitAvailabilityChange();
      // Flush any config patches that failed before the worker was ready
      if (this.started && Object.keys(this.pendingConfig).length > 0) {
        void this.client.configure(this.pendingConfig).catch(() => {});
      }
    });
    this.client.on("runtime-disconnected", ({ reason }) => {
      this.connected = false;
      this.lastRuntimeHealth = null;
      this.lastHealth = { ready: false, reason };
      this.activeRun = null;
      this.clearLocalChatSessions();
      this.emitAvailabilityChange();
    });
    this.client.on("runtime-ready", (snapshot) => {
      this.lastRuntimeHealth = snapshot;
      this.emitAvailabilityChange();
    });
    this.client.on("run-event", (event) => {
      if (
        event.type === AGENT_STREAM_EVENT_TYPES.RUN_STARTED &&
        event.conversationId
      ) {
        this.activeRun = {
          runId: event.runId,
          conversationId: event.conversationId,
        };
      }
      if (event.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
        if (this.activeRun?.runId === event.runId) {
          this.activeRun = null;
        }
      }
      if (event.requestId) {
        this.dispatchLocalChatSessionEvent(event.requestId, event);
      }
    });
    this.client.on("run-self-mod-hmr-state", (payload) => {
      this.dispatchLocalChatSessionHmrState(payload);
    });
  }

  private clearLocalChatSessionCleanup(requestId: string) {
    const session = this.localChatSessions.get(requestId);
    if (!session?.cleanupTimer) {
      return;
    }
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  private clearLocalChatSession(requestId: string) {
    this.clearLocalChatSessionCleanup(requestId);
    this.localChatSessions.delete(requestId);
  }

  private clearLocalChatSessions() {
    for (const requestId of [...this.localChatSessions.keys()]) {
      this.clearLocalChatSession(requestId);
    }
  }

  private scheduleLocalChatSessionCleanup(requestId: string) {
    const session = this.localChatSessions.get(requestId);
    if (!session) {
      return;
    }
    if (session.activeRunIds.size > 0 || session.activeTaskIds.size > 0) {
      this.clearLocalChatSessionCleanup(requestId);
      return;
    }
    this.clearLocalChatSessionCleanup(requestId);
    session.cleanupTimer = setTimeout(() => {
      const current = this.localChatSessions.get(requestId);
      if (!current) {
        return;
      }
      if (current.activeRunIds.size > 0 || current.activeTaskIds.size > 0) {
        return;
      }
      this.clearLocalChatSession(requestId);
    }, LOCAL_CHAT_SESSION_IDLE_CLEANUP_MS);
  }

  private shouldIgnoreLocalChatSessionEvent(
    session: LocalChatSession,
    event: RuntimeAgentEventPayload,
  ) {
    if (
      typeof event.conversationId === "string" &&
      event.conversationId !== session.conversationId
    ) {
      return true;
    }

    const scopeKey = `${isTaskScopedEvent(event.type) ? "task" : "run"}:${event.rootRunId ?? event.runId}`;
    const previousSeq = session.lastSeqByScope.get(scopeKey);
    if (typeof previousSeq === "number" && event.seq <= previousSeq) {
      return true;
    }
    session.lastSeqByScope.set(scopeKey, event.seq);
    return false;
  }

  private dispatchLocalChatSessionEvent(
    requestId: string,
    event: RuntimeAgentEventPayload,
  ) {
    const session = this.localChatSessions.get(requestId);
    if (!session) {
      return;
    }
    if (this.shouldIgnoreLocalChatSessionEvent(session, event)) {
      return;
    }

    this.clearLocalChatSessionCleanup(requestId);
    session.knownRunIds.add(event.runId);

    const taskKey =
      event.agentId && (event.rootRunId ?? event.runId)
        ? `${event.rootRunId ?? event.runId}:${event.agentId}`
        : null;

    if (event.type === AGENT_STREAM_EVENT_TYPES.RUN_STARTED) {
      session.activeRunIds.add(event.runId);
    } else if (isRunTerminalEvent(event.type)) {
      session.activeRunIds.delete(event.runId);
    }

    if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED && taskKey) {
      session.activeTaskIds.add(taskKey);
    } else if (isTaskLifecycleTerminalType(event.type) && taskKey) {
      session.activeTaskIds.delete(taskKey);
    }

    switch (event.type) {
      case AGENT_STREAM_EVENT_TYPES.RUN_STARTED:
        session.callbacks.onRunStarted?.(event);
        break;
      case AGENT_STREAM_EVENT_TYPES.STREAM:
        session.callbacks.onStream(event);
        break;
      case AGENT_STREAM_EVENT_TYPES.AGENT_REASONING:
        session.callbacks.onAgentReasoning?.(event);
        break;
      case AGENT_STREAM_EVENT_TYPES.STATUS:
        session.callbacks.onStatus?.(event);
        break;
      case AGENT_STREAM_EVENT_TYPES.TOOL_START:
        session.callbacks.onToolStart(event);
        break;
      case AGENT_STREAM_EVENT_TYPES.TOOL_END:
        session.callbacks.onToolEnd(event);
        break;
      case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED:
        session.callbacks.onRunFinished(event);
        break;
      default:
        if (isTaskLifecycleEventType(event.type)) {
          session.callbacks.onAgentEvent?.({
            type: event.type as AgentLifecycleEvent["type"],
            conversationId: session.conversationId,
            rootRunId: event.rootRunId ?? event.runId,
            agentId: event.agentId ?? "",
            agentType: event.agentType ?? "",
            ...(event.description ? { description: event.description } : {}),
            ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
            ...(event.result ? { result: event.result } : {}),
            ...(event.error ? { error: event.error } : {}),
            ...(event.statusText ? { statusText: event.statusText } : {}),
          });
        }
        break;
    }

    this.scheduleLocalChatSessionCleanup(requestId);
  }

  private dispatchLocalChatSessionHmrState(payload: {
    runId?: string;
    state: SelfModHmrState;
  }) {
    if (payload.runId) {
      for (const session of this.localChatSessions.values()) {
        if (!session.knownRunIds.has(payload.runId)) {
          continue;
        }
        session.callbacks.onSelfModHmrState?.(payload.state);
      }
      return;
    }

    for (const session of this.localChatSessions.values()) {
      if (session.activeRunIds.size === 0) {
        continue;
      }
      session.callbacks.onSelfModHmrState?.(payload.state);
    }
  }

  private emitAvailabilityChange() {
    const snapshot = this.getAvailabilitySnapshot();
    if (
      this.lastAvailabilitySnapshot &&
      this.lastAvailabilitySnapshot.connected === snapshot.connected &&
      this.lastAvailabilitySnapshot.ready === snapshot.ready &&
      this.lastAvailabilitySnapshot.reason === snapshot.reason
    ) {
      return;
    }
    this.lastAvailabilitySnapshot = snapshot;
    for (const listener of this.availabilityListeners) {
      listener(snapshot);
    }
  }

  private waitForAvailability(
    predicate: (snapshot: RuntimeAvailabilitySnapshot) => boolean,
    timeoutMs: number,
    fallbackMessage: string,
  ) {
    const initial = this.getAvailabilitySnapshot();
    if (predicate(initial)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          createRuntimeUnavailableError(
            this.getAvailabilitySnapshot().reason ?? fallbackMessage,
          ),
        );
      }, timeoutMs);
      const unsubscribe = this.onAvailabilityChange((snapshot) => {
        if (!predicate(snapshot)) {
          return;
        }
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  getAvailabilitySnapshot(): RuntimeAvailabilitySnapshot {
    const ready = Boolean(this.connected && this.lastRuntimeHealth?.ready);
    const reason =
      this.lastRuntimeHealth && !this.lastRuntimeHealth.ready
        ? "Stella runtime host is not ready."
        : this.lastHealth?.reason ??
      (!this.connected ? "Stella runtime client is not connected." : undefined);
    return {
      connected: this.connected,
      ready,
      ...(reason ? { reason } : {}),
    };
  }

  onAvailabilityChange(
    listener: (snapshot: RuntimeAvailabilitySnapshot) => void,
  ): () => void {
    this.availabilityListeners.add(listener);
    return () => {
      this.availabilityListeners.delete(listener);
    };
  }

  async start() {
    await this.client.start();
    this.started = true;
    if (Object.keys(this.pendingConfig).length > 0) {
      try {
        await this.client.configure(this.pendingConfig);
        this.lastConfigureError = null;
      } catch (error) {
        this.lastConfigureError =
          error instanceof Error ? error.message : String(error ?? "Runtime configure failed.");
        throw error;
      }
    }
    this.lastRuntimeHealth = await this.client.health();
    this.lastHealth = await this.client.healthCheck();
    this.activeRun = await this.client.getActiveRun();
    this.emitAvailabilityChange();
  }

  async stop() {
    this.started = false;
    this.clearLocalChatSessions();
    await this.client.stop();
  }

  private queueRuntimeConfigPatch(patch: {
    convexUrl?: string | null;
    convexSiteUrl?: string | null;
    authToken?: string | null;
    hasConnectedAccount?: boolean;
    cloudSyncEnabled?: boolean;
  }) {
    this.pendingConfig = {
      ...this.pendingConfig,
      ...patch,
    };
    this.queuedConfigPatch = {
      ...this.queuedConfigPatch,
      ...patch,
    };

    if (!this.started) {
      return;
    }
    if (this.configFlushQueued) {
      return;
    }
    this.configFlushQueued = true;
    queueMicrotask(() => {
      this.configFlushQueued = false;
      if (!this.started) {
        return;
      }

      const nextPatch = this.queuedConfigPatch;
      this.queuedConfigPatch = {};
      if (Object.keys(nextPatch).length === 0) {
        return;
      }

      void this.client.configure(nextPatch).then(
        () => {
          this.lastConfigureError = null;
        },
        (error) => {
          this.lastConfigureError =
            error instanceof Error ? error.message : String(error ?? "Runtime configure failed.");
          console.warn("[stella-runtime-adapter] Failed to apply runtime config patch:", {
            patch: nextPatch,
            error: this.lastConfigureError,
          });
        },
      );
    });
  }

  async waitUntilReady(timeoutMs = 10_000) {
    if (this.getAvailabilitySnapshot().ready) {
      return;
    }
    const initial = await this.agentHealthCheck();
    if (initial?.ready) {
      return;
    }
    await this.waitForAvailability(
      (snapshot) => snapshot.ready,
      timeoutMs,
      "Runtime not available.",
    );
  }

  async waitUntilConnected(timeoutMs = 10_000) {
    if (this.getAvailabilitySnapshot().connected) {
      return;
    }
    await this.waitForAvailability(
      (snapshot) => snapshot.connected,
      timeoutMs,
      "Stella runtime client is not connected.",
    );
  }

  setConvexUrl(value: string | null) {
    this.queueRuntimeConfigPatch({ convexUrl: value });
  }

  setConvexSiteUrl(value: string | null) {
    this.queueRuntimeConfigPatch({ convexSiteUrl: value });
  }

  setAuthToken(value: string | null) {
    this.queueRuntimeConfigPatch({ authToken: value });
  }

  setHasConnectedAccount(value: boolean) {
    this.queueRuntimeConfigPatch({ hasConnectedAccount: value });
  }

  setCloudSyncEnabled(enabled: boolean) {
    this.queueRuntimeConfigPatch({ cloudSyncEnabled: enabled });
  }

  getStellaSiteAuth(): { baseUrl: string; authToken: string } | null {
    const baseUrl = readConfiguredStellaSiteUrl(
      this.pendingConfig.convexSiteUrl ?? null,
    );
    const authToken = this.pendingConfig.authToken?.trim() || null;
    if (!baseUrl || !authToken) {
      return null;
    }
    return { baseUrl, authToken };
  }

  async agentHealthCheck() {
    try {
      const value = await this.client.healthCheck();
      this.lastHealth = value ?? { ready: false };
    } catch (error) {
      this.lastHealth = {
        ready: false,
        reason:
          error instanceof Error
            ? error.message
            : String(error ?? "Stella runtime client is not connected."),
      };
    }
    this.emitAvailabilityChange();
    return this.lastHealth;
  }

  async getActiveOrchestratorRun() {
    try {
      this.activeRun = await this.client.getActiveRun();
    } catch {
      this.activeRun = null;
    }
    return this.activeRun;
  }

  async resumeRunEvents(payload: { runId: string; lastSeq: number }) {
    return await this.client.resumeRunEvents(payload);
  }

  cancelLocalChat(runId: string) {
    return void this.client.cancelChat(runId);
  }

  async handleLocalChat(
    payload: {
      conversationId: string;
      userPrompt: string;
      selectedText?: string | null;
      chatContext?: import("../../runtime/contracts/index.js").ChatContext | null;
      deviceId?: string;
      platform?: string;
      timezone?: string;
      mode?: string;
      messageMetadata?: Record<string, unknown>;
      attachments?: Array<{
        url: string;
        mimeType?: string;
      }>;
      agentType?: string;
      storageMode?: "cloud" | "local";
      requestId?: string;
    },
    callbacks: AgentCallbacks,
  ) {
    const requestId =
      typeof payload.requestId === "string" && payload.requestId.trim().length > 0
        ? payload.requestId
        : `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    this.clearLocalChatSession(requestId);
    this.localChatSessions.set(requestId, {
      requestId,
      conversationId: payload.conversationId,
      callbacks,
      knownRunIds: new Set<string>(),
      activeRunIds: new Set<string>(),
      activeTaskIds: new Set<string>(),
      lastSeqByScope: new Map<string, number>(),
      cleanupTimer: null,
    });

    try {
      const result = await this.client.startChat({
        ...payload,
        requestId,
      });
      this.localChatSessions.get(requestId)?.knownRunIds.add(result.runId);
      return result;
    } catch (error) {
      this.clearLocalChatSession(requestId);
      throw error;
    }
  }

  async sendAgentInput(payload: {
    conversationId: string;
    threadId: string;
    message: string;
    interrupt?: boolean;
    metadata?: Record<string, unknown>;
  }) {
    return await this.client.sendAgentInput(payload);
  }

  runAutomationTurn(payload: RuntimeAutomationTurnRequest) {
    return this.client.runAutomationTurn(payload);
  }

  runBlockingLocalAgent(payload: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType?: string;
    selfModMetadata?: {
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update" | "uninstall";
    };
  }) {
    return this.client.runBlockingLocalAgent(payload);
  }

  createBackgroundAgent(payload: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType?: string;
    selfModMetadata?: {
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update" | "uninstall";
    };
  }) {
    return this.client.createBackgroundAgent(payload);
  }

  getLocalAgentSnapshot(agentId: string) {
    return this.client.getLocalAgentSnapshot(agentId);
  }

  appendThreadMessage(args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) {
    return void this.client.appendThreadMessage(args);
  }

  persistVoiceTranscript(args: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    uiVisibility?: "visible" | "hidden";
  }) {
    return this.client.persistVoiceTranscript(args);
  }

  async handleVoiceChat(
    payload: {
      conversationId: string;
      message: string;
    },
    callbacks: AgentCallbacks,
  ) {
    const requestId =
      globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let lastRunEventSeq = 0;
    let lastTaskEventSeq = 0;
    const activeTaskIds = new Set<string>();
    const knownRunIds = new Set<string>();
    let runTerminated = false;

    let unsubscribe = () => {};
    const maybeUnsubscribe = () => {
      if (!runTerminated || activeTaskIds.size > 0) {
        return;
      }
      unsubscribe();
    };

    const dispatch = (event: RuntimeAgentEventPayload) => {
      if (event.runId) {
        knownRunIds.add(event.runId);
      }
      const taskLifecycleEvent = isTaskLifecycleEventType(event.type);

      if (taskLifecycleEvent) {
        if (event.seq <= lastTaskEventSeq) {
          return;
        }
        lastTaskEventSeq = event.seq;
      } else {
        if (event.seq <= lastRunEventSeq) {
          return;
        }
        lastRunEventSeq = event.seq;
      }

      if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED && event.agentId) {
        activeTaskIds.add(event.agentId);
      } else if (isTaskLifecycleTerminalType(event.type) && event.agentId) {
        activeTaskIds.delete(event.agentId);
      }

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.STREAM:
          callbacks.onStream(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.STATUS:
          callbacks.onStatus?.(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_START:
          callbacks.onToolStart(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_END:
          callbacks.onToolEnd(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED:
          callbacks.onRunFinished(event);
          break;
        default:
          if (taskLifecycleEvent) {
            callbacks.onAgentEvent?.({
              type: event.type as AgentLifecycleEvent["type"],
              conversationId: payload.conversationId,
              rootRunId: event.runId,
              agentId: event.agentId ?? "",
              agentType: event.agentType ?? "",
              ...(event.description ? { description: event.description } : {}),
              ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
              ...(event.result ? { result: event.result } : {}),
              ...(event.error ? { error: event.error } : {}),
              ...(event.statusText ? { statusText: event.statusText } : {}),
            });
          }
          break;
      }
      if (isRunTerminalEvent(event.type)) {
        runTerminated = true;
      }
      maybeUnsubscribe();
    };

    const offEvent = this.client.on("voice-agent-event", (eventPayload) => {
      if (eventPayload.requestId !== requestId) {
        return;
      }
      dispatch(eventPayload.event);
    });
    const offHmr = this.client.on("voice-self-mod-hmr-state", (hmrPayload) => {
      if (hmrPayload.requestId !== requestId) {
        return;
      }
      if (hmrPayload.runId) {
        knownRunIds.add(hmrPayload.runId);
      }
      callbacks.onSelfModHmrState?.(hmrPayload.state);
    });
    const offRunHmr = this.client.on("run-self-mod-hmr-state", (hmrPayload) => {
      if (!hmrPayload.runId && knownRunIds.size === 0) {
        return;
      }
      if (
        hmrPayload.runId &&
        knownRunIds.size > 0 &&
        !knownRunIds.has(hmrPayload.runId)
      ) {
        return;
      }
      if (hmrPayload.runId) {
        knownRunIds.add(hmrPayload.runId);
      }
      callbacks.onSelfModHmrState?.(hmrPayload.state);
    });
    unsubscribe = () => {
      offEvent();
      offHmr();
      offRunHmr();
    };

    try {
      return await this.client.voiceOrchestratorChat({
        requestId,
        ...payload,
      } satisfies RuntimeVoiceChatPayload);
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  webSearch(query: string, options?: { category?: string }) {
    return this.client.webSearch(query, options);
  }

  voiceWebSearch(payload: { query: string; category?: string }) {
    return this.client.voiceWebSearch(payload);
  }

  listStorePackages() {
    return this.client.listStorePackages();
  }

  listInstalledMods() {
    return this.client.listInstalledMods();
  }

  readSelfModFeatureSnapshot() {
    return this.client.readSelfModFeatureSnapshot();
  }

  getStorePackage(packageId: string) {
    return this.client.getStorePackage(packageId);
  }

  listStorePackageReleases(packageId: string) {
    return this.client.listStorePackageReleases(packageId);
  }

  getStorePackageRelease(packageId: string, releaseNumber: number) {
    return this.client.getStorePackageRelease(packageId, releaseNumber);
  }

  createFirstStoreRelease(args: StorePublishArgs) {
    return this.client.createFirstStoreRelease(args);
  }

  createStoreReleaseUpdate(args: StorePublishArgs) {
    return this.client.createStoreReleaseUpdate(args);
  }

  publishStoreBlueprint(args: StorePublishBlueprintArgs) {
    return this.client.publishStoreBlueprint(args);
  }

  uninstallStoreMod(packageId: string) {
    return this.client.uninstallStoreMod(packageId);
  }

  installFromBlueprint(payload: {
    packageId: string;
    releaseNumber: number;
    displayName: string;
    blueprintMarkdown: string;
    commits?: Array<{ hash: string; subject: string; diff: string }>;
  }) {
    return this.client.installFromBlueprint(payload);
  }

  getStoreThread() {
    return this.client.getStoreThread();
  }

  sendStoreThreadMessage(payload: {
    text: string;
    attachedFeatureNames?: string[];
    editingBlueprint?: boolean;
  }) {
    return this.client.sendStoreThreadMessage(payload);
  }

  cancelStoreThreadTurn() {
    return this.client.cancelStoreThreadTurn();
  }

  denyLatestStoreBlueprint() {
    return this.client.denyLatestStoreBlueprint();
  }

  markStoreBlueprintPublished(payload: {
    messageId: string;
    releaseNumber: number;
  }) {
    return this.client.markStoreBlueprintPublished(payload);
  }

  listCronJobs() {
    return this.client.listCronJobs();
  }

  listHeartbeats() {
    return this.client.listHeartbeats();
  }

  runCronJob(jobId: string) {
    return this.client.runCronJob(jobId);
  }

  removeCronJob(jobId: string) {
    return this.client.removeCronJob(jobId);
  }

  updateCronJob(
    jobId: string,
    patch: import("../../runtime/kernel/shared/scheduling.js").LocalCronJobUpdatePatch,
  ) {
    return this.client.updateCronJob(jobId, patch);
  }

  upsertHeartbeat(
    input: import("../../runtime/kernel/shared/scheduling.js").LocalHeartbeatUpsertInput,
  ) {
    return this.client.upsertHeartbeat(input);
  }

  runHeartbeat(conversationId: string) {
    return this.client.runHeartbeat(conversationId);
  }

  listConversationEvents(args: { conversationId: string; maxItems?: number }) {
    return this.client.listConversationEvents(args);
  }

  getConversationEventCount(args: { conversationId: string }) {
    return this.client.getConversationEventCount(args);
  }

  onScheduleUpdated(listener: () => void) {
    return this.client.on("schedule-updated", listener);
  }

  onLocalChatUpdated(listener: () => void) {
    return this.client.on("local-chat-updated", listener);
  }

  onGoogleWorkspaceAuthRequired(listener: () => void) {
    return this.client.on("google-workspace-auth-required", listener);
  }

  onVoiceActionCompleted(
    listener: (payload: RuntimeVoiceActionCompletedPayload) => void,
  ) {
    return this.client.on("voice-action-completed", listener);
  }

  createSocialSession(payload: { roomId: string; workspaceLabel?: string }) {
    return this.client.createSocialSession(payload);
  }

  updateSocialSessionStatus(payload: {
    sessionId: string;
    status: RuntimeSocialSessionStatus;
  }) {
    return this.client.updateSocialSessionStatus(payload);
  }

  queueSocialSessionTurn(payload: {
    sessionId: string;
    prompt: string;
    agentType?: string;
    clientTurnId?: string;
  }) {
    return this.client.queueSocialSessionTurn(payload);
  }

  getSocialSessionStatus() {
    return this.client.getSocialSessionStatus();
  }

  revertSelfModFeature(payload: { featureId?: string; steps?: number }) {
    return this.client.revertSelfModFeature(payload);
  }

  getCrashRecoveryStatus() {
    return this.client.getCrashRecoveryStatus();
  }

  discardUnfinishedSelfModChanges() {
    return this.client.discardUnfinishedSelfModChanges();
  }

  getLastSelfModFeature() {
    return this.client.getLastSelfModFeature();
  }

  listRecentSelfModFeatures(limit?: number): Promise<SelfModFeatureSummary[]> {
    return this.client.listRecentSelfModFeatures(limit);
  }

  killAllShells() {
    return void this.client.killAllShells();
  }

  killShellsByPort(port: number) {
    return this.client.killShellsByPort(port);
  }

  collectBrowserData(options?: { selectedBrowser?: string; selectedProfile?: string }) {
    return this.client.collectBrowserData(options);
  }

  collectAllSignals(options?: {
    categories?: string[];
    selectedBrowser?: string;
    selectedProfile?: string;
  }) {
    return this.client.collectAllSignals(options);
  }

  coreMemoryExists() {
    return this.client.coreMemoryExists();
  }

  discoveryKnowledgeExists() {
    return this.client.discoveryKnowledgeExists();
  }

  writeCoreMemory(
    content: string,
    options?: { includeLocation?: boolean },
  ) {
    return this.client.writeCoreMemory(content, options);
  }

  writeDiscoveryKnowledge(payload: DiscoveryKnowledgeSeedPayload) {
    return this.client.writeDiscoveryKnowledge(payload);
  }

  detectPreferredBrowserProfile() {
    return this.client.detectPreferredBrowserProfile();
  }

  listBrowserProfiles(browserType: string) {
    return this.client.listBrowserProfiles(browserType);
  }

  googleWorkspaceGetAuthStatus() {
    return this.client.googleWorkspaceGetAuthStatus();
  }

  googleWorkspaceConnect() {
    return this.client.googleWorkspaceConnect();
  }

  googleWorkspaceDisconnect() {
    return this.client.googleWorkspaceDisconnect();
  }

  triggerDreamNow(
    trigger?:
      | "manual"
      | "subagent_finalize"
      | "chronicle_summary"
      | "startup_catchup",
  ) {
    return this.client.triggerDreamNow(trigger);
  }

  runChronicleSummaryTick(window: "10m" | "6h") {
    return this.client.runChronicleSummaryTick(window);
  }
}
