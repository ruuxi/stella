import type { SelfModHmrState } from "../packages/stella-boundary-contracts/src/index.js";
import {
  AGENT_STREAM_EVENT_TYPES,
} from "../src/shared/contracts/agent-runtime.js";
import type {
  RuntimeActiveRun,
  RuntimeAgentEventPayload,
  RuntimeAutomationTurnRequest,
  StorePublishArgs,
} from "../packages/stella-runtime-protocol/src/index.js";
import {
  StellaRuntimeClient,
  type StellaRuntimeClientOptions,
} from "../packages/stella-runtime-client/src/index.js";
import { createRuntimeUnavailableError } from "../packages/stella-runtime-protocol/src/rpc-peer.js";
import type { TaskLifecycleEvent } from "./core/runtime/tasks/local-task-manager.js";

type AgentCallbacks = {
  onStream: (event: RuntimeAgentEventPayload) => void;
  onToolStart: (event: RuntimeAgentEventPayload) => void;
  onToolEnd: (event: RuntimeAgentEventPayload) => void;
  onError: (event: RuntimeAgentEventPayload) => void;
  onEnd: (event: RuntimeAgentEventPayload) => void;
  onTaskEvent?: (event: TaskLifecycleEvent) => void;
  onSelfModHmrState?: (event: SelfModHmrState) => void;
  onHmrResume?: (args: {
    resumeHmr: () => Promise<void>;
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }) => Promise<void>;
};

export type RuntimeAvailabilitySnapshot = {
  connected: boolean;
  ready: boolean;
  reason?: string;
};

const isTerminalEvent = (type: string) =>
  type === AGENT_STREAM_EVENT_TYPES.END || type === AGENT_STREAM_EVENT_TYPES.ERROR;

export class RuntimeClientAdapter {
  readonly client: StellaRuntimeClient;
  private lastHealth:
    | { ready: boolean; reason?: string; runnerVersion?: string; engine?: string }
    | null = null;
  private activeRun: RuntimeActiveRun | null = null;
  private connected = false;
  private started = false;
  private lastConfigureError: string | null = null;
  private lastAvailabilitySnapshot: RuntimeAvailabilitySnapshot | null = null;
  private pendingConfig: {
    convexUrl?: string | null;
    convexSiteUrl?: string | null;
    authToken?: string | null;
    cloudSyncEnabled?: boolean;
  } = {};
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
    });
    this.client.on("runtime-disconnected", ({ reason }) => {
      this.connected = false;
      this.lastHealth = { ready: false, reason };
      this.activeRun = null;
      this.emitAvailabilityChange();
    });
    this.client.on("runtime-ready", (snapshot) => {
      this.lastHealth = snapshot.ready
        ? { ready: true }
        : { ready: false, reason: "Runtime reported not ready." };
      this.emitAvailabilityChange();
    });
    this.client.on("run-event", (event) => {
      if (event.type === AGENT_STREAM_EVENT_TYPES.ERROR || event.type === AGENT_STREAM_EVENT_TYPES.END) {
        if (this.activeRun?.runId === event.runId) {
          this.activeRun = null;
        }
      }
    });
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
    const ready = Boolean(this.lastHealth?.ready);
    const reason =
      this.lastHealth?.reason ??
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
    this.lastHealth = await this.client.healthCheck();
    this.activeRun = await this.client.getActiveRun();
    this.emitAvailabilityChange();
  }

  async stop() {
    this.started = false;
    await this.client.stop();
  }

  private queueRuntimeConfigPatch(patch: {
    convexUrl?: string | null;
    convexSiteUrl?: string | null;
    authToken?: string | null;
    cloudSyncEnabled?: boolean;
  }) {
    this.pendingConfig = {
      ...this.pendingConfig,
      ...patch,
    };
    if (!this.started) {
      return;
    }
    void this.client.configure(patch).then(
      () => {
        this.lastConfigureError = null;
      },
      (error) => {
        this.lastConfigureError =
          error instanceof Error ? error.message : String(error ?? "Runtime configure failed.");
        console.warn("[stella-runtime-adapter] Failed to apply runtime config patch:", {
          patch,
          error: this.lastConfigureError,
        });
      },
    );
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

  setCloudSyncEnabled(enabled: boolean) {
    this.queueRuntimeConfigPatch({ cloudSyncEnabled: enabled });
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

  cancelLocalChat(runId: string) {
    return void this.client.cancelChat(runId);
  }

  async handleLocalChat(
    payload: {
      conversationId: string;
      userMessageId: string;
      userPrompt: string;
      agentType?: string;
      storageMode?: "cloud" | "local";
    },
    callbacks: AgentCallbacks,
  ) {
    const result = await this.client.startChat(payload);
    this.activeRun = {
      runId: result.runId,
      conversationId: payload.conversationId,
    };
    let lastRunEventSeq = 0;
    let lastTaskEventSeq = 0;

    const dispatch = (event: RuntimeAgentEventPayload) => {
      if (event.runId !== result.runId) {
        return;
      }
      const isTaskLifecycleEvent =
        event.type !== AGENT_STREAM_EVENT_TYPES.STREAM &&
        event.type !== AGENT_STREAM_EVENT_TYPES.TOOL_START &&
        event.type !== AGENT_STREAM_EVENT_TYPES.TOOL_END &&
        event.type !== AGENT_STREAM_EVENT_TYPES.ERROR &&
        event.type !== AGENT_STREAM_EVENT_TYPES.END;

      if (isTaskLifecycleEvent) {
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

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.STREAM:
          callbacks.onStream(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_START:
          callbacks.onToolStart(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_END:
          callbacks.onToolEnd(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.ERROR:
          callbacks.onError(event);
          break;
        case AGENT_STREAM_EVENT_TYPES.END:
          callbacks.onEnd(event);
          break;
        default:
          callbacks.onTaskEvent?.({
            type: event.type as TaskLifecycleEvent["type"],
            conversationId: payload.conversationId,
            rootRunId: event.runId,
            taskId: event.taskId ?? "",
            agentType: event.agentType ?? "",
            ...(event.description ? { description: event.description } : {}),
            ...(event.parentTaskId ? { parentTaskId: event.parentTaskId } : {}),
            ...(event.result ? { result: event.result } : {}),
            ...(event.error ? { error: event.error } : {}),
            ...(event.statusText ? { statusText: event.statusText } : {}),
          });
          break;
      }
      if (isTerminalEvent(event.type)) {
        unsubscribe();
      }
    };

    const offEvent = this.client.on("run-event", dispatch);
    const offHmr = this.client.on("run-self-mod-hmr-state", (payload) => {
      if (!payload.runId || payload.runId === result.runId) {
        callbacks.onSelfModHmrState?.(payload.state);
      }
    });
    const unsubscribe = () => {
      offEvent();
      offHmr();
    };

    const buffered = await this.client.resumeRunEvents({
      runId: result.runId,
      lastSeq: 0,
    });
    for (const event of buffered.events) {
      dispatch(event);
    }

    return result;
  }

  runAutomationTurn(payload: RuntimeAutomationTurnRequest) {
    return this.client.runAutomationTurn(payload);
  }

  runBlockingLocalTask(payload: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType?: string;
    selfModMetadata?: {
      featureId?: string;
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update";
      displayName?: string;
      description?: string;
    };
  }) {
    return this.client.runBlockingLocalTask(payload);
  }

  createBackgroundTask(payload: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType?: string;
    selfModMetadata?: {
      featureId?: string;
      packageId?: string;
      releaseNumber?: number;
      mode?: "author" | "install" | "update";
      displayName?: string;
      description?: string;
    };
  }) {
    return this.client.createBackgroundTask(payload);
  }

  getLocalTaskSnapshot(taskId: string) {
    return this.client.getLocalTaskSnapshot(taskId);
  }

  appendThreadMessage(args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  }) {
    return void this.client.appendThreadMessage(args);
  }

  webSearch(query: string, options?: { category?: string; displayResults?: boolean }) {
    return this.client.webSearch(query, options);
  }

  listStorePackages() {
    return this.client.listStorePackages();
  }

  listLocalFeatures(limit?: number) {
    return this.client.listLocalFeatures(limit);
  }

  listFeatureBatches(featureId: string) {
    return this.client.listFeatureBatches(featureId);
  }

  createReleaseDraft(args: { featureId: string; batchIds?: string[] }) {
    return this.client.createReleaseDraft(args);
  }

  listInstalledMods() {
    return this.client.listInstalledMods();
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

  publishStoreRelease(args: {
    featureId: string;
    batchIds?: string[];
    packageId?: string;
    displayName?: string;
    description?: string;
    releaseNotes?: string;
  }) {
    return this.client.publishStoreRelease(args);
  }

  installStoreRelease(args: { packageId: string; releaseNumber?: number }) {
    return this.client.installStoreRelease(args);
  }

  uninstallStoreMod(packageId: string) {
    return this.client.uninstallStoreMod(packageId);
  }

  listCronJobs() {
    return this.client.listCronJobs();
  }

  listHeartbeats() {
    return this.client.listHeartbeats();
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

  getSocialSessionStatus() {
    return this.client.getSocialSessionStatus();
  }

  killAllShells() {
    return void this.client.killAllShells();
  }

  killShellsByPort(port: number) {
    return this.client.killShellsByPort(port);
  }
}
