import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonRpcPeer } from "../protocol/rpc-peer.js";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type AgentHealth,
  type HostDeviceIdentity,
  type HostHeartbeatSignature,
  type RuntimeAgentEventPayload,
  type RuntimeChatPayload,
  type StorePublishArgs,
  type RuntimeTaskRequest,
} from "../protocol/index.js";
import {
  AGENT_IDS,
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
  type AgentStreamEventType,
} from "../../src/shared/contracts/agent-runtime.js";
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
import { getDevServerUrl } from "../../electron/dev-url.js";
import {
  detectSelfModAppliedSince,
  getLastGitFeatureId,
  getGitHead,
  listRecentGitFeatures,
} from "../kernel/self-mod/git.js";
import { createSelfModHmrController } from "../kernel/self-mod/hmr.js";
import { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import { revertGitCommits, revertGitFeature } from "../kernel/self-mod/git.js";
import { createDesktopDatabase } from "../kernel/storage/database.js";
import { ChatStore } from "../kernel/storage/chat-store.js";
import { RuntimeStore } from "../kernel/storage/runtime-store.js";
import { StoreModStore } from "../kernel/storage/store-mod-store.js";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import { TranscriptMirror } from "../kernel/storage/transcript-mirror.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
} from "../contracts/index.js";
import { SocialSessionService } from "./social-sessions/service.js";
import { SocialSessionStore } from "./social-sessions/store.js";
import { VoiceRuntimeService } from "./voice/service.js";

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

type RuntimeRunner = ReturnType<typeof createStellaHostRunner>;

type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
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
  voiceService: VoiceRuntimeService | null;
  runner: RuntimeRunner | null;
  deviceId: string | null;
};

const resolveRuntimeCliPath = () =>
  fileURLToPath(new URL("../../kernel/cli/stella-ui.js", import.meta.url));

const writeBlueprintArtifact = async (args: {
  stellaHomePath: string;
  packageId: string;
  releaseNumber: number;
  artifact: StoreReleaseArtifact;
}): Promise<string> => {
  const releaseDir = path.join(
    args.stellaHomePath,
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
    `Target featureId: ${args.packageRecord.featureId}. Target releaseNumber: ${args.release.releaseNumber}.`,
  ].join("\n\n");

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

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
    state.init = init;

    const db = createDesktopDatabase(init.stellaHomePath);
    const transcriptMirror = new TranscriptMirror(path.join(init.stellaHomePath, "state"));
    const chatStore = new ChatStore(db, transcriptMirror);
    const runtimeStore = new RuntimeStore(db, transcriptMirror);
    const storeModStore = new StoreModStore(db);
    const socialSessionStore = new SocialSessionStore(db);
    const storeModService = new StoreModService(init.frontendRoot, storeModStore);
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
      getDefaultConversationId: () =>
        chatStore.getOrCreateDefaultConversationId(),
      requestCredential: async (payload) =>
        await peer.request(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, payload),
      displayHtml: async (html) => {
        await peer.request(METHOD_NAMES.HOST_DISPLAY_UPDATE, { html });
      },
      scheduleApi: {
        listCronJobs: async () =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS),
        addCronJob: async (input) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB, input),
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
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG, {
            conversationId,
          }),
        upsertHeartbeat: async (input) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT, input),
        runHeartbeat: async (conversationId) =>
          await peer.request(METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT, {
            conversationId,
          }),
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
          await peer.request(METHOD_NAMES.HOST_RUNTIME_RELOAD_PAUSE, {
            runId,
          }).catch((error) => {
            console.warn(
              "[self-mod-reload] Failed to pause host runtime reloads:",
              (error as Error).message,
            );
          });
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
          await peer.request(METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME, {
            runId,
          }).catch((error) => {
            console.warn(
              "[self-mod-reload] Failed to resume host runtime reloads:",
              (error as Error).message,
            );
          });
        },
        cancelRun: async (runId) => {
          storeModService.cancelSelfModRun(runId);
          await peer.request(METHOD_NAMES.HOST_RUNTIME_RELOAD_RESUME, {
            runId,
          }).catch((error) => {
            console.warn(
              "[self-mod-reload] Failed to resume host runtime reloads:",
              (error as Error).message,
            );
          });
        },
      },
      stellaBrowserBinPath: path.join(
        init.frontendRoot,
        "stella-browser",
        "bin",
        "stella-browser.js",
      ),
      stellaOfficeBinPath: path.join(
        init.frontendRoot,
        "stella-office",
        "bin",
        "stella-office.js",
      ),
      stellaUiCliPath: resolveRuntimeCliPath(),
      onGoogleWorkspaceAuthRequired: () => {
        peer.notify(NOTIFICATION_NAMES.GOOGLE_WORKSPACE_AUTH_REQUIRED, null);
      },
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
      requestHostHmrTransition: async (payload) => {
        await peer.request(METHOD_NAMES.HOST_HMR_RUN_TRANSITION, payload);
      },
    });

    return {
      pid: process.pid,
      deviceId: state.deviceId,
    };
  };

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE, async (params) => {
    const result = await initializeWorker(params as WorkerInitializationState);
    if (pendingConfigPatch) {
      applyConfigPatch(pendingConfigPatch);
      pendingConfigPatch = null;
    }
    return result;
  });

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

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, async (params) => {
    const patch = params as Partial<WorkerInitializationState>;
    if (!state.init) {
      // Queue the patch — it will be applied after initialization
      pendingConfigPatch = { ...pendingConfigPatch, ...patch };
      return { ok: true, queued: true };
    }
    applyConfigPatch(patch);
    return { ok: true };
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_HEALTH, async () => {
    const health = state.runner?.agentHealthCheck() ?? ({ ready: false } satisfies AgentHealth);
    const socialSessions =
      state.socialSessionService?.getSnapshot() ?? {
        enabled: false,
        status: "stopped",
        sessionCount: 0,
        sessions: [],
      };
    return {
      health,
      activeRun: state.runner?.getActiveOrchestratorRun() ?? null,
      activeTaskCount: state.runner?.getActiveTaskCount() ?? 0,
      pid: process.pid,
      deviceId: state.deviceId,
      voiceBusy: state.voiceService?.isBusy() ?? false,
      pendingVoiceRequestCount: state.voiceService?.getPendingRequestCount() ?? 0,
      remoteBridgeActive: Boolean(
        state.init?.convexUrl
          && state.init?.authToken
          && state.init?.hasConnectedAccount,
      ),
      socialSessions,
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
    let hiddenUserMessageCount = 0;
    const result = await ensureRunner().handleLocalChat({
      conversationId: payload.conversationId,
      userMessageId,
      userPrompt: payload.userPrompt,
      attachments: payload.attachments,
      agentType: payload.agentType,
      storageMode: payload.storageMode,
    }, {
      onUserMessage: (ev) => {
        const hiddenTimestamp = Math.max(
          0,
          userMessageTimestamp - 1000 + hiddenUserMessageCount,
        );
        hiddenUserMessageCount += 1;
        ensureChatStore().appendEvent({
          conversationId: payload.conversationId,
          type: "user_message",
          requestId: userMessageId,
          timestamp: hiddenTimestamp,
          payload: prepareStoredLocalChatPayload({
            type: "user_message",
            payload: {
              text: ev.text,
              metadata: {
                ui: {
                  visibility: ev.uiVisibility ?? "hidden",
                },
              },
            },
            timestamp: hiddenTimestamp,
            timezone: payload.timezone,
          }),
        });
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
      },
      onStream: (ev) => emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.STREAM }),
      onStatus: (ev) => emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.STATUS }),
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
            ...(ev.agentType ? { agentType: ev.agentType } : {}),
          },
        });
        peer.notify(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, null);
        emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.TOOL_END });
      },
      onError: (ev) => emitRunEvent({ ...ev, type: AGENT_STREAM_EVENT_TYPES.ERROR }),
      onTaskEvent: (ev) => {
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
        });
        if (ev.type === "task-completed") {
          peer.request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
            title: "Task completed",
            body: ev.description ?? ev.result ?? "A task finished successfully.",
          }).catch(() => {});
        } else if (ev.type === "task-failed") {
          peer.request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
            title: "Task failed",
            body: ev.description ?? ev.error ?? "A task encountered an error.",
          }).catch(() => {});
        }
      },
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
          agentType: "general",
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
          type: "home_suggestions",
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

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA,
    async (params) => {
      if (!state.init) {
        throw new Error("Worker has not been initialized.");
      }
      const payload = (params as
        | { selectedBrowser?: string; selectedProfile?: string }
        | undefined) ?? { };
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
      const payload = (params as
        | {
            categories?: string[];
            selectedBrowser?: string;
            selectedProfile?: string;
          }
        | undefined) ?? { };
      return await collectAllSignals(
        state.init.stellaHomePath,
        payload.categories as
          | import("../../src/shared/contracts/discovery.js").DiscoveryCategory[]
          | undefined,
        payload.selectedBrowser,
        payload.selectedProfile,
      );
    },
  );

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

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE, async (params) => {
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
  });

  peer.registerRequestHandler(
    METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS,
    async (params) => {
      if (!state.socialSessionService) {
        throw new Error("Social session service is unavailable.");
      }
      const payload = params as { sessionId?: string; status?: "active" | "paused" | "ended" };
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

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN, async (params) => {
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
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS, async () => {
    return state.socialSessionService?.getSnapshot() ?? {
      enabled: false,
      status: "stopped",
      sessionCount: 0,
      sessions: [],
    };
  });

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

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS, async () => {
    return await ensureRunner().googleWorkspaceGetAuthStatus();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT, async () => {
    return await ensureRunner().googleWorkspaceConnect();
  });

  peer.registerRequestHandler(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT, async () => {
    return await ensureRunner().googleWorkspaceDisconnect();
  });

  peer.registerRequestHandler(METHOD_NAMES.RUNTIME_HEALTH, async () => {
    return {
      ready: Boolean(state.runner?.agentHealthCheck().ready),
      hostPid: process.pid,
      workerPid: process.pid,
      workerRunning: true,
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
