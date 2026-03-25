import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonRpcPeer } from "../runtime-protocol/rpc-peer.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type AgentHealth,
  type CapabilityStateEventRecord,
  type CapabilityStateValue,
  type HostDeviceIdentity,
  type HostHeartbeatSignature,
  type RuntimeAgentEventPayload,
  type RuntimeChatPayload,
  type RuntimeCommandRunParams,
  type RuntimeOverlayAutoPanelEventPayload,
  type RuntimeOverlayAutoPanelStartPayload,
  type RuntimeOverlayChatMessage,
  type RuntimePersonalWebsiteGenerationRequest,
  type StorePublishArgs,
  type RuntimeTaskRequest,
} from "../runtime-protocol/index.js";
import { CapabilityRuntime } from "../runtime-capabilities/runtime.js";
import type { CapabilityStateApi } from "../runtime-capabilities/types.js";
import {
  AGENT_IDS,
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
  type AgentStreamEventType,
} from "../../src/shared/contracts/agent-runtime.js";
import { prepareStoredLocalChatPayload } from "../runtime-kernel/storage/local-chat-payload.js";
import {
  createStellaHostRunner,
  type StellaHostRunnerOptions,
} from "../runtime-kernel/runner.js";
import { getDevServerUrl } from "../../electron/dev-url.js";
import {
  detectSelfModAppliedSince,
  getLastGitFeatureId,
  getGitHead,
  listRecentGitFeatures,
} from "../runtime-kernel/self-mod/git.js";
import { createSelfModHmrController } from "../runtime-kernel/self-mod/hmr.js";
import { StoreModService } from "../runtime-kernel/self-mod/store-mod-service.js";
import { revertGitCommits, revertGitFeature } from "../runtime-kernel/self-mod/git.js";
import { LocalSchedulerService } from "../runtime-kernel/local-scheduler-service.js";
import { createDesktopDatabase } from "../runtime-kernel/storage/database.js";
import { ChatStore } from "../runtime-kernel/storage/chat-store.js";
import { RuntimeStore } from "../runtime-kernel/storage/runtime-store.js";
import { StoreModStore } from "../runtime-kernel/storage/store-mod-store.js";
import type { SqliteDatabase } from "../runtime-kernel/storage/shared.js";
import { TranscriptMirror } from "../runtime-kernel/storage/transcript-mirror.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
} from "../boundary-contracts/index.js";
import { SocialSessionService } from "./social-sessions/service.js";
import { SocialSessionStore } from "./social-sessions/store.js";
import { VoiceRuntimeService } from "./voice/service.js";
import { DevProjectService } from "../runtime-kernel/dev-projects/dev-project-service.js";
import { readAssistantText, streamSimple } from "../ai/stream.js";
import { resolveLlmRoute } from "../runtime-kernel/model-routing.js";
import {
  getDefaultModel,
  getModelOverride,
} from "../runtime-kernel/preferences/local-preferences.js";
import {
  buildStellaChatContext,
  type ChatMessage,
} from "../runtime-kernel/stella-provider.js";
import {
  startPersonalWebsiteGeneration,
} from "../runtime-kernel/dashboard-generation.js";

type WorkerInitializationState = {
  stellaHomePath: string;
  stellaWorkspacePath: string;
  frontendRoot: string;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  cloudSyncEnabled: boolean;
};

type RuntimeRunner = ReturnType<typeof createStellaHostRunner>;

type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  selfModApplied?: { featureId: string; files: string[]; batchIndex: number };
  taskId?: string;
  agentType?: AgentIdLike;
  description?: string;
  parentTaskId?: string;
  result?: string;
  statusText?: string;
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
  devProjectService: DevProjectService | null;
  devProjectSubscription: (() => void) | null;
  voiceService: VoiceRuntimeService | null;
  schedulerService: LocalSchedulerService | null;
  schedulerSubscription: (() => void) | null;
  runner: RuntimeRunner | null;
  capabilityRuntime: CapabilityRuntime | null;
  deviceId: string | null;
  overlayAutoPanelControllers: Map<string, AbortController>;
};

const ensureCapabilityTables = (db: SqliteDatabase) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_state (
      module_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      key TEXT NOT NULL,
      json_value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (module_id, scope, entity_id, key)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_state_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      json_value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_capability_state_events_lookup
    ON capability_state_events(module_id, scope, entity_id, created_at);
  `);
};

const normalizeEntityId = (value: string | undefined) => value?.trim() ?? "";

const createCapabilityStateApi = (db: SqliteDatabase): CapabilityStateApi => ({
  async get(args) {
    const row = db
      .prepare(
        `
      SELECT module_id AS moduleId, scope, entity_id AS entityId, key, json_value AS jsonValue, updated_at AS updatedAt
      FROM capability_state
      WHERE module_id = ? AND scope = ? AND entity_id = ? AND key = ?
      LIMIT 1
    `,
      )
      .get(
        args.moduleId,
        args.scope,
        normalizeEntityId(args.entityId),
        args.key,
      ) as
      | {
          moduleId: string;
          scope: string;
          entityId: string;
          key: string;
          jsonValue: string;
          updatedAt: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      moduleId: row.moduleId,
      scope: row.scope as CapabilityStateValue["scope"],
      entityId: row.entityId,
      key: row.key,
      jsonValue: JSON.parse(row.jsonValue),
      updatedAt: row.updatedAt,
    };
  },
  async set(args) {
    const now = Date.now();
    const entityId = normalizeEntityId(args.entityId);
    db.prepare(
      `
      INSERT INTO capability_state (module_id, scope, entity_id, key, json_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(module_id, scope, entity_id, key)
      DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at
    `,
    ).run(
      args.moduleId,
      args.scope,
      entityId,
      args.key,
      JSON.stringify(args.jsonValue ?? null),
      now,
    );
    return {
      moduleId: args.moduleId,
      scope: args.scope,
      entityId,
      key: args.key,
      jsonValue: args.jsonValue,
      updatedAt: now,
    };
  },
  async appendEvent(args) {
    const now = Date.now();
    const entityId = normalizeEntityId(args.entityId);
    db.prepare(
      `
      INSERT INTO capability_state_events (module_id, scope, entity_id, event_type, json_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      args.moduleId,
      args.scope,
      entityId,
      args.eventType,
      JSON.stringify(args.jsonValue ?? null),
      now,
    );
    return {
      moduleId: args.moduleId,
      scope: args.scope,
      entityId,
      eventType: args.eventType,
      jsonValue: args.jsonValue,
      createdAt: now,
    } satisfies CapabilityStateEventRecord;
  },
});

const resolveRuntimeCliPath = () =>
  fileURLToPath(new URL("../../runtime-kernel/cli/stella-ui.js", import.meta.url));

const createCapabilityRuntime = (args: {
  peer: JsonRpcPeer;
  frontendRoot: string;
  stellaHomePath: string;
  runner: RuntimeRunner;
  db: SqliteDatabase;
}) =>
  new CapabilityRuntime({
    frontendRoot: args.frontendRoot,
    stellaHomePath: args.stellaHomePath,
    getProxy: () => args.runner.getProxy(),
    host: {
      ui: {
        snapshot: async () => await args.peer.request(METHOD_NAMES.HOST_UI_SNAPSHOT),
        act: async (params) => await args.peer.request(METHOD_NAMES.HOST_UI_ACT, params),
      },
    },
    state: createCapabilityStateApi(args.db),
  });

const writeBlueprintArtifact = async (args: {
  stellaHomePath: string;
  packageId: string;
  releaseNumber: number;
  artifact: StoreReleaseArtifact;
}): Promise<string> => {
  const releaseDir = path.join(
    args.stellaHomePath,
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
    `Target featureId: ${args.packageRecord.featureId}. Target releaseNumber: ${args.release.releaseNumber}.`,
  ].join("\n\n");

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isOverlayChatMessageArray = (
  value: unknown,
): value is RuntimeOverlayChatMessage[] => Array.isArray(value);

const toOverlayChatMessages = (
  value: RuntimeOverlayChatMessage[] | undefined,
): ChatMessage[] =>
  (Array.isArray(value) ? value : []).map((message) => ({
    role: message.role,
    content: message.content,
  }));

const stopWorkerServices = async (state: WorkerState) => {
  for (const controller of state.overlayAutoPanelControllers.values()) {
    controller.abort();
  }
  state.overlayAutoPanelControllers.clear();
  state.devProjectSubscription?.();
  state.devProjectSubscription = null;
  await state.devProjectService?.stopAll();
  state.devProjectService = null;
  state.schedulerSubscription?.();
  state.schedulerSubscription = null;
  state.socialSessionService?.stop();
  state.socialSessionService = null;
  state.voiceService = null;
  state.schedulerService?.stop();
  state.schedulerService = null;
  state.runner?.stop();
  state.runner = null;
  state.capabilityRuntime = null;
  state.chatStore = null;
  state.runtimeStore = null;
  state.storeModStore = null;
  state.storeModService = null;
  state.socialSessionStore = null;
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
    devProjectService: null,
    devProjectSubscription: null,
    voiceService: null,
    schedulerService: null,
    schedulerSubscription: null,
    runner: null,
    capabilityRuntime: null,
    deviceId: null,
    overlayAutoPanelControllers: new Map(),
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

  const emitProjectsUpdated = async () => {
    if (!state.devProjectService) {
      return;
    }
    peer.notify(
      NOTIFICATION_NAMES.PROJECTS_UPDATED,
      await state.devProjectService.listProjects(),
    );
  };

  const emitOverlayAutoPanelEvent = (
    payload: RuntimeOverlayAutoPanelEventPayload,
  ) => {
    peer.notify(NOTIFICATION_NAMES.OVERLAY_AUTO_PANEL_EVENT, payload);
  };

  const ensureRunner = () => {
    if (!state.runner) {
      throw new Error("Runtime worker is not ready.");
    }
    return state.runner;
  };

  const ensureScheduler = () => {
    if (!state.schedulerService) {
      throw new Error("Scheduler service is not available.");
    }
    return state.schedulerService;
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

  const ensureDevProjectService = () => {
    if (!state.devProjectService) {
      throw new Error("Dev project service is not available.");
    }
    return state.devProjectService;
  };

  const ensureCapabilityRuntime = () => {
    if (!state.capabilityRuntime) {
      throw new Error("Capability runtime is not available.");
    }
    return state.capabilityRuntime;
  };

  const initializeWorker = async (init: WorkerInitializationState) => {
    await stopWorkerServices(state);
    state.init = init;

    const db = createDesktopDatabase(init.stellaHomePath);
    ensureCapabilityTables(db);
    const transcriptMirror = new TranscriptMirror(path.join(init.stellaHomePath, "state"));
    const chatStore = new ChatStore(db, transcriptMirror);
    const runtimeStore = new RuntimeStore(db, transcriptMirror);
    const storeModStore = new StoreModStore(db);
    const socialSessionStore = new SocialSessionStore(db);
    const storeModService = new StoreModService(init.frontendRoot, storeModStore);
    const devProjectService = new DevProjectService({
      getStellaHomePath: () => state.init?.stellaHomePath ?? null,
    });
    const deviceIdentity = await peer.request<HostDeviceIdentity>(
      METHOD_NAMES.HOST_DEVICE_IDENTITY_GET,
    );
    state.deviceId = deviceIdentity.deviceId;

    state.db = db;
    state.chatStore = chatStore;
    state.runtimeStore = runtimeStore;
    state.storeModStore = storeModStore;
    state.storeModService = storeModService;
    state.socialSessionStore = socialSessionStore;
    state.devProjectService = devProjectService;
    state.devProjectSubscription = devProjectService.subscribe(() => {
      void emitProjectsUpdated();
    });

    const runnerTarget = {
      getRunner: () => state.runner,
    };

    const schedulerService = new LocalSchedulerService({
      stellaHome: init.stellaHomePath,
      runnerTarget,
    });
    state.schedulerService = schedulerService;
    state.schedulerSubscription = schedulerService.subscribe(() => {
      peer.notify(NOTIFICATION_NAMES.SCHEDULE_UPDATED, null);
    });

    const runnerOptions: StellaHostRunnerOptions = {
      deviceId: deviceIdentity.deviceId,
      stellaHomePath: init.stellaHomePath,
      frontendRoot: init.frontendRoot,
      runtimeStore,
      listLocalChatEvents: (conversationId, maxItems) =>
        chatStore.listEvents(conversationId, maxItems),
      appendLocalChatEvent: (args) => {
        chatStore.appendEvent(args);
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      },
      requestCredential: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, payload),
      displayHtml: async (html) => {
        await peer.request(METHOD_NAMES.HOST_DISPLAY_UPDATE, { html });
      },
      scheduleApi: {
        listCronJobs: async () => schedulerService.listCronJobs(),
        addCronJob: async (input) => schedulerService.addCronJob(input),
        updateCronJob: async (jobId, patch) => schedulerService.updateCronJob(jobId, patch),
        removeCronJob: async (jobId) => schedulerService.removeCronJob(jobId),
        runCronJob: async (jobId) => schedulerService.runCronJob(jobId),
        getHeartbeatConfig: async (conversationId) =>
          schedulerService.getHeartbeatConfig(conversationId),
        upsertHeartbeat: async (input) => schedulerService.upsertHeartbeat(input),
        runHeartbeat: async (conversationId) => schedulerService.runHeartbeat(conversationId),
      },
      signHeartbeatPayload: async (signedAtMs) => ({
        ...(await peer.request<HostHeartbeatSignature>(
          METHOD_NAMES.HOST_DEVICE_HEARTBEAT_SIGN,
          { signedAtMs },
        )),
      }),
      selfModMonitor: {
        getBaselineHead: getGitHead,
        detectAppliedSince: detectSelfModAppliedSince,
      },
      selfModHmrController: createSelfModHmrController({
        getDevServerUrl,
        enabled: process.env.NODE_ENV === "development",
      }),
      getHmrTransitionController: () => ({
        runTransition: async ({ runId, requiresFullReload }) => {
          await peer.request(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, {
            runId,
            requiresFullReload,
          });
        },
      }),
      selfModLifecycle: {
        beginRun: async ({ runId, taskDescription, featureId, packageId, releaseNumber, mode, displayName, description }) => {
          await storeModService.beginSelfModRun({
            runId,
            taskDescription,
            featureId,
            packageId,
            releaseNumber,
            applyMode: mode,
            displayName,
            description,
          });
        },
        finalizeRun: async ({ runId, succeeded }) => {
          await storeModService.finalizeSelfModRun({ runId, succeeded });
        },
        cancelRun: async (runId) => {
          storeModService.cancelSelfModRun(runId);
        },
      },
      stellaBrowserBinPath: path.join(
        init.frontendRoot,
        "stella-browser",
        "bin",
        "stella-browser.js",
      ),
      stellaUiCliPath: resolveRuntimeCliPath(),
    };

    const runner = createStellaHostRunner(runnerOptions);
    state.runner = runner;
    runner.setConvexUrl(init.convexUrl);
    runner.setAuthToken(init.authToken);
    runner.setCloudSyncEnabled(init.cloudSyncEnabled);
    runner.start();

    schedulerService.start();

    const socialSessionService = new SocialSessionService({
      getWorkspaceRoot: () => init.stellaWorkspacePath,
      getDeviceId: () => state.deviceId,
      getRunner: () => state.runner,
      getChatStore: () => state.chatStore,
      getStore: () => state.socialSessionStore,
      onLocalChatUpdated: () => {
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      },
    });
    socialSessionService.setConvexUrl(init.convexUrl);
    socialSessionService.setAuthToken(init.authToken);
    socialSessionService.start();
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
      requestHostHmrTransition: async (payload) => {
        await peer.request(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, payload);
      },
    });

    const capabilityRuntime = createCapabilityRuntime({
      peer,
      frontendRoot: init.frontendRoot,
      stellaHomePath: init.stellaHomePath,
      runner,
      db,
    });
    await capabilityRuntime.load();
    state.capabilityRuntime = capabilityRuntime;

    return {
      pid: process.pid,
      deviceId: state.deviceId,
      commandSourcePaths: capabilityRuntime.getLoadedSourcePaths(),
    };
  };

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE, async (params) => {
    return await initializeWorker(params as WorkerInitializationState);
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, async (params) => {
    const patch = params as Partial<WorkerInitializationState>;
    if (!state.init) {
      throw new Error("Worker has not been initialized.");
    }
    state.init = { ...state.init, ...patch };
    if (patch.convexUrl !== undefined) {
      state.runner?.setConvexUrl(patch.convexUrl);
      state.socialSessionService?.setConvexUrl(patch.convexUrl);
    }
    if (patch.authToken !== undefined) {
      state.runner?.setAuthToken(patch.authToken);
      state.socialSessionService?.setAuthToken(patch.authToken);
    }
    if (patch.cloudSyncEnabled !== undefined) {
      state.runner?.setCloudSyncEnabled(patch.cloudSyncEnabled);
    }
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_HEALTH, async () => {
    const health = state.runner?.agentHealthCheck() ?? ({ ready: false } satisfies AgentHealth);
    return {
      health,
      activeRun: state.runner?.getActiveOrchestratorRun() ?? null,
      activeTaskCount: state.runner?.getActiveTaskCount() ?? 0,
      pid: process.pid,
      deviceId: state.deviceId,
    };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_RELOAD_CAPABILITIES, async () => {
    await ensureCapabilityRuntime().load();
    return {
      ok: true,
      sourcePaths: ensureCapabilityRuntime().getLoadedSourcePaths(),
    };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GET_ACTIVE, async () => {
    return ensureRunner().getActiveOrchestratorRun();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_START_CHAT, async (params) => {
    const payload = params as RuntimeChatPayload;
    const userMessageTimestamp = Date.now();
    const userMessageEvent = ensureChatStore().appendEvent({
      conversationId: payload.conversationId,
      type: "user_message",
      deviceId: payload.deviceId,
      timestamp: userMessageTimestamp,
      payload: prepareStoredLocalChatPayload({
        type: "user_message",
        payload: {
          text: payload.userPrompt,
          ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
          ...(payload.platform ? { platform: payload.platform } : {}),
          ...(payload.timezone ? { timezone: payload.timezone } : {}),
          ...(payload.messageMetadata ? { metadata: payload.messageMetadata } : {}),
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
    const result = await ensureRunner().handleLocalChat({
      conversationId: payload.conversationId,
      userMessageId,
      userPrompt: payload.userPrompt,
      attachments: payload.attachments,
      agentType: payload.agentType,
      storageMode: payload.storageMode,
    }, {
      onStream: (ev) => emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.STREAM }),
      onToolStart: (ev) => {
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
        emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_START });
      },
      onToolEnd: (ev) => {
        ensureChatStore().appendEvent({
          conversationId: payload.conversationId,
          type: "tool_result",
          requestId: ev.toolCallId,
          payload: {
            toolName: ev.toolName,
            result: ev.resultPreview,
            resultPreview: ev.resultPreview,
            ...(ev.agentType ? { agentType: ev.agentType } : {}),
          },
        });
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
        emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_END });
      },
      onError: (ev) => emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.ERROR }),
      onTaskEvent: (ev) =>
        emitRunEvent({
          type: ev.type,
          runId: ev.rootRunId ?? activeRunId ?? payload.conversationId,
          seq: syntheticSeq++,
          taskId: ev.taskId,
          agentType: ev.agentType,
          description: ev.description,
          parentTaskId: ev.parentTaskId,
          result: ev.result,
          error: ev.error,
          statusText: ev.statusText,
        }),
      onEnd: (ev) => {
        if ((ev.agentType ?? AGENT_IDS.ORCHESTRATOR) === AGENT_IDS.ORCHESTRATOR) {
          ensureChatStore().appendEvent({
            conversationId: payload.conversationId,
            type: "assistant_message",
            requestId: userMessageId,
            payload: prepareStoredLocalChatPayload({
              type: "assistant_message",
              payload: {
                text: ev.finalText,
                userMessageId,
              },
              timestamp: Date.now(),
              timezone: payload.timezone,
            }),
          });
          peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
        }
        emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.END });
      },
      onSelfModHmrState: (statePayload) =>
        emitSelfModHmrState({ runId: activeRunId || undefined, state: statePayload }),
      onHmrResume: async ({ runId, requiresFullReload }) => {
        await peer.request(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, {
          runId,
          requiresFullReload,
        });
      },
    });
    activeRunId = result.runId;
    return { ...result, userMessageId };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_CANCEL, async (params) => {
    ensureRunner().cancelLocalChat((params as { runId: string }).runId);
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, async (params) => {
    return await ensureRunner().runAutomationTurn(
      params as {
        conversationId: string;
        userPrompt: string;
        agentType?: string;
      },
    );
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_TASK,
    async (params) => {
      const payload = params as RuntimeTaskRequest;
      return await ensureRunner().runBlockingLocalTask({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_TASK,
    async (params) => {
      const payload = params as RuntimeTaskRequest;
      return await ensureRunner().createBackgroundTask({
        ...payload,
        agentType: payload.agentType ?? "general",
      });
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GET_TASK_SNAPSHOT, async (params) => {
    return await ensureRunner().getLocalTaskSnapshot((params as { taskId: string }).taskId);
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE, async (params) => {
    ensureRunner().appendThreadMessage(
      params as {
        threadKey: string;
        role: "user" | "assistant";
        content: string;
      },
    );
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH, async (params) => {
    const payload = params as { query: string; category?: string; displayResults?: boolean };
    return await ensureRunner().webSearch(payload.query, {
      category: payload.category,
      displayResults: payload.displayResults,
    });
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT,
    async (params) => {
      return ensureVoiceService().persistTranscript(
        params as {
          conversationId: string;
          role: "user" | "assistant";
          text: string;
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

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_VOICE_WEB_SEARCH, async (params) => {
    return await ensureVoiceService().webSearch(
      params as {
        query: string;
        category?: string;
      },
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES, async () => {
    return await ensureRunner().listStorePackages();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE, async (params) => {
    return await ensureRunner().getStorePackage((params as { packageId: string }).packageId);
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES, async (params) => {
    return await ensureRunner().listStorePackageReleases(
      (params as { packageId: string }).packageId,
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE, async (params) => {
    const payload = params as { packageId: string; releaseNumber: number };
    return await ensureRunner().getStorePackageRelease(
      payload.packageId,
      payload.releaseNumber,
    );
  });

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

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_PUBLISH_STORE_RELEASE, async (params) => {
    const payload = params as {
      featureId: string;
      batchIds?: string[];
      packageId?: string;
      displayName?: string;
      description?: string;
      releaseNotes?: string;
    };
    const runner = ensureRunner();
    const service = ensureStoreModService();
    const existing = payload.packageId
      ? await runner.getStorePackage(payload.packageId)
      : null;
    return await service.publishRelease({
      ...payload,
      releaseNumber: existing ? existing.latestReleaseNumber + 1 : 1,
      publish: (args) =>
        existing
          ? runner.createStoreReleaseUpdate(args)
          : runner.createFirstStoreRelease(args),
    });
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_INSTALL_STORE_RELEASE, async (params) => {
    if (!state.init) {
      throw new Error("Worker has not been initialized.");
    }
    const payload = params as { packageId: string; releaseNumber?: number };
    const runner = ensureRunner();
    const service = ensureStoreModService();
    const requestedReleaseNumber =
      typeof payload.releaseNumber === "number" && Number.isFinite(payload.releaseNumber)
        ? Math.max(1, Math.floor(payload.releaseNumber))
        : undefined;
    const availableReleases = await runner.listStorePackageReleases(payload.packageId);
    if (!requestedReleaseNumber && availableReleases.length === 0) {
      throw new Error(`Package "${payload.packageId}" has no published releases.`);
    }
    const releaseNumber =
      requestedReleaseNumber ??
      Math.max(1, ...availableReleases.map((entry) => entry.releaseNumber));

    const result = await service.installRelease({
      packageId: payload.packageId,
      releaseNumber,
      fetchRelease: async ({ packageId, releaseNumber }) => {
        const release = await runner.getStorePackageRelease(packageId, releaseNumber);
        const packageRecord = await runner.getStorePackage(packageId);
        if (!release || !packageRecord) {
          throw new Error("Store release not found.");
        }
        if (!release.artifactUrl) {
          throw new Error("Store release artifact URL is unavailable.");
        }
        const response = await fetch(release.artifactUrl);
        if (!response.ok) {
          throw new Error(`Failed to download release artifact (${response.status}).`);
        }
        const artifact = (await response.json()) as StoreReleaseArtifact;
        return {
          package: packageRecord,
          release,
          artifact,
        };
      },
      applyRelease: async ({ package: packageRecord, release, artifact, mode }) => {
        const blueprintPath = await writeBlueprintArtifact({
          stellaHomePath: state.init!.stellaHomePath,
          packageId: packageRecord.packageId,
          releaseNumber: release.releaseNumber,
          artifact,
        });
        const taskResult = await runner.runBlockingLocalTask({
          conversationId: `store:${packageRecord.packageId}`,
          description: `${mode === "update" ? "Update" : "Install"} ${packageRecord.displayName} from store`,
          prompt: buildStoreInstallPrompt({
            blueprintPath,
            packageRecord,
            release,
            mode,
          }),
          agentType: "self_mod",
          selfModMetadata: {
            featureId: packageRecord.featureId,
            packageId: packageRecord.packageId,
            releaseNumber: release.releaseNumber,
            mode,
            displayName: packageRecord.displayName,
            description: packageRecord.description,
          },
        });
        if (taskResult.status !== "ok") {
          throw new Error(taskResult.error);
        }
      },
    });
    return result.installRecord;
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_UNINSTALL_STORE_MOD, async (params) => {
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
      repoRoot: state.init.frontendRoot,
      commitHashes: [...install.applyCommitHashes].reverse(),
    });
    service.markInstallUninstalled(install.installId);
    return {
      packageId: payload.packageId,
      revertedCommits,
    };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LIST_COMMANDS, async () => {
    return ensureCapabilityRuntime().listCommands();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_RUN_COMMAND, async (params) => {
    return await ensureCapabilityRuntime().runCommand(params as RuntimeCommandRunParams);
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR, async (params) => {
    const runId = (params as { runId?: string } | undefined)?.runId?.trim();
    if (!runId) {
      throw new Error("INTERNAL_WORKER_RESUME_HMR requires a runId.");
    }
    const options =
      (params as {
        options?: { suppressClientFullReload?: boolean };
      } | undefined)?.options;
    const resumeApplied = await ensureRunner().resumeSelfModHmr(runId, options);
    return { ok: Boolean(resumeApplied) };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS, async () => {
    ensureRunner().killAllShells();
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT, async () => {
    return ensureChatStore().getOrCreateDefaultConversationId();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS, async (params) => {
    const payload = params as { conversationId?: string; maxItems?: number };
    return ensureChatStore().listEvents(payload.conversationId ?? "", payload.maxItems);
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT, async (params) => {
    return ensureChatStore().getEventCount(
      (params as { conversationId?: string }).conversationId ?? "",
    );
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME,
    async (params) => {
      const payload = params as {
        conversationId?: string;
        message?: string;
        suggestions?: unknown[];
      };
      const conversationId = payload.conversationId ?? "";
      const message = typeof payload.message === "string" ? payload.message : "";
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
          type: "welcome_suggestions",
          payload: { suggestions },
        });
      }
      peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      return { ok: true as const };
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES, async (params) => {
    const payload = params as { conversationId?: string; maxMessages?: number };
    return ensureChatStore().listSyncMessages(
      payload.conversationId ?? "",
      payload.maxMessages,
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT, async (params) => {
    return ensureChatStore().getSyncCheckpoint(
      (params as { conversationId?: string }).conversationId ?? "",
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT, async (params) => {
    const payload = params as { conversationId?: string; localMessageId?: string };
    ensureChatStore().setSyncCheckpoint(
      payload.conversationId ?? "",
      payload.localMessageId ?? "",
    );
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_FEATURES, async (params) => {
    return ensureStoreModService().listLocalFeatures(
      (params as { limit?: number } | undefined)?.limit,
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_BATCHES, async (params) => {
    return ensureStoreModService().listFeatureBatches(
      (params as { featureId: string }).featureId,
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_CREATE_RELEASE_DRAFT, async (params) => {
    return ensureStoreModService().createReleaseDraft(
      params as { featureId: string; batchIds?: string[] },
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_STORE_MODS_LIST_INSTALLED, async () => {
    return ensureStoreModService().listInstalledMods();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_LIST_CRON_JOBS, async () => {
    return ensureScheduler().listCronJobs();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_LIST_HEARTBEATS, async () => {
    return ensureScheduler().listHeartbeats();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_LIST_EVENTS, async (params) => {
    const payload = params as { conversationId: string; maxItems?: number };
    return ensureScheduler().listConversationEvents(
      payload.conversationId,
      payload.maxItems,
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SCHEDULE_GET_EVENT_COUNT, async (params) => {
    return ensureScheduler().getConversationEventCount(
      (params as { conversationId: string }).conversationId,
    );
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS, async () => {
    return state.socialSessionService?.getSnapshot() ?? {
      enabled: false,
      status: "stopped",
      sessionCount: 0,
      sessions: [],
    };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_PROJECTS_LIST, async () => {
    return await ensureDevProjectService().listProjects();
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_PROJECTS_REGISTER_DIRECTORY,
    async (params) => {
      const projectPath = asTrimmedString(
        (params as { projectPath?: string } | undefined)?.projectPath,
      );
      if (!projectPath) {
        throw new Error("Project path is required.");
      }
      return await ensureDevProjectService().pickProjectDirectory(projectPath);
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_PROJECTS_START, async (params) => {
    const projectId = asTrimmedString(
      (params as { projectId?: string } | undefined)?.projectId,
    );
    if (!projectId) {
      throw new Error("Project ID is required.");
    }
    return await ensureDevProjectService().startProject(projectId);
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_PROJECTS_STOP, async (params) => {
    const projectId = asTrimmedString(
      (params as { projectId?: string } | undefined)?.projectId,
    );
    if (!projectId) {
      throw new Error("Project ID is required.");
    }
    return await ensureDevProjectService().stopProject(projectId);
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_OVERLAY_AUTO_PANEL_START,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = params as RuntimeOverlayAutoPanelStartPayload;
      const requestId = asTrimmedString(payload?.requestId);
      if (!requestId) {
        throw new Error("Missing auto panel request ID.");
      }

      const agentType = asTrimmedString(payload?.agentType) || "auto";
      const messages = toOverlayChatMessages(
        isOverlayChatMessageArray(payload?.messages) ? payload.messages : [],
      );

      state.overlayAutoPanelControllers.get(requestId)?.abort();
      const abortController = new AbortController();
      state.overlayAutoPanelControllers.set(requestId, abortController);

      void (async () => {
        try {
          const stellaHomePath = state.init?.stellaHomePath;
          if (!stellaHomePath) {
            throw new Error("Local Stella home is unavailable.");
          }

          const authToken = state.init?.authToken ?? null;
          const resolvedRoute = resolveLlmRoute({
            stellaHomePath,
            modelName:
              getModelOverride(stellaHomePath, agentType) ??
              getDefaultModel(stellaHomePath, agentType),
            agentType,
            proxy: {
              baseUrl: state.init?.convexSiteUrl ?? null,
              getAuthToken: () => authToken,
            },
          });

          const stream = streamSimple(
            resolvedRoute.model,
            buildStellaChatContext(messages),
            {
              apiKey: resolvedRoute.getApiKey(),
              signal: abortController.signal,
            },
          );

          let fullText = "";
          for await (const streamEvent of stream) {
            if (streamEvent.type !== "text_delta") {
              continue;
            }
            fullText += streamEvent.delta;
            emitOverlayAutoPanelEvent({
              requestId,
              kind: "chunk",
              chunk: streamEvent.delta,
            });
          }

          const finalMessage = await stream.result();
          if (
            abortController.signal.aborted ||
            finalMessage.stopReason === "aborted"
          ) {
            return;
          }
          if (finalMessage.stopReason === "error") {
            throw new Error(
              finalMessage.errorMessage || "Auto panel request failed",
            );
          }
          emitOverlayAutoPanelEvent({
            requestId,
            kind: "complete",
            text: fullText || readAssistantText(finalMessage),
          });
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }
          emitOverlayAutoPanelEvent({
            requestId,
            kind: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (state.overlayAutoPanelControllers.get(requestId) === abortController) {
            state.overlayAutoPanelControllers.delete(requestId);
          }
        }
      })();

      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_OVERLAY_AUTO_PANEL_CANCEL,
    async (params) => {
      const requestId = asTrimmedString(
        (params as { requestId?: string } | undefined)?.requestId,
      );
      if (!requestId) {
        return { ok: true };
      }
      const controller = state.overlayAutoPanelControllers.get(requestId);
      if (controller) {
        state.overlayAutoPanelControllers.delete(requestId);
        controller.abort();
      }
      return { ok: true };
    },
  );

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DASHBOARD_START_PERSONAL_WEBSITE_GENERATION,
    async (params) => {
      await startPersonalWebsiteGeneration(
        (request) => ensureRunner().createBackgroundTask(request),
        (taskId) => ensureRunner().getLocalTaskSnapshot(taskId),
        params as RuntimePersonalWebsiteGenerationRequest,
      );
      return undefined;
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_REVERT, async (params) => {
    if (!state.init) {
      throw new Error("Worker has not been initialized.");
    }
    const payload = params as { featureId?: string; steps?: number };
    return await revertGitFeature({
      repoRoot: state.init.frontendRoot,
      featureId: payload.featureId,
      steps: payload.steps,
    });
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_LAST_FEATURE, async () => {
    if (!state.init) {
      throw new Error("Worker has not been initialized.");
    }
    return await getLastGitFeatureId(state.init.frontendRoot);
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SELF_MOD_RECENT_FEATURES,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const rawLimit = (params as { limit?: number } | undefined)?.limit;
      const limit = Number.isFinite(rawLimit) ? Number(rawLimit) : 8;
      return await listRecentGitFeatures(state.init.frontendRoot, limit);
    },
  );

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT, async (params) => {
    ensureRunner().killShellsByPort((params as { port: number }).port);
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_HEALTH, async () => {
    return {
      ready: Boolean(state.runner?.agentHealthCheck().ready),
      daemonPid: null,
      workerPid: process.pid,
      workerGeneration: 0,
      deviceId: state.deviceId,
      activeRunId: state.runner?.getActiveOrchestratorRun()?.runId ?? null,
      activeTaskCount: state.runner?.getActiveTaskCount() ?? 0,
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
