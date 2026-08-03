import {
  buildAgentContext,
  createRunnerContext,
  getConfiguredModel,
  resolveAgentModelRoute,
  resolveAgent,
} from "./runner/context.js";
import { createConvexSession } from "./runner/convex-session.js";
import { createOrchestratorController } from "./runner/orchestrator.js";
import { createRuntimeInitialization } from "./runner/runtime-initialization.js";
import { createStoreOperations } from "./runner/store-operations.js";
import { createAgentOrchestration } from "./runner/agent-orchestration.js";
import { buildRuntimeSystemPrompt } from "./agent-runtime/run-preparation.js";
import { getRuntimeToolMetadata } from "./agent-runtime/tool-adapters.js";
import { AGENT_IDS } from "../contracts/agent-runtime.js";
import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "./agents/local-agent-manager.js";
import {
  convertRestartShutdownRecordAtBoot,
  fireRestartContinuationTurn,
} from "./restart-continuation.js";
import type {
  RunnerPublicApi,
  StellaHostRunnerOptions,
} from "./runner/types.js";

export type { StellaHostRunnerOptions } from "./runner/types.js";
export {
  getConvexErrorCode,
  getConvexErrorMessage,
  isConvexDeviceKeyMismatchError,
  isConvexUnauthenticatedError,
  REMOTE_TURN_AUTH_GRACE_MS,
  REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS,
  shouldStopRemoteTurnForAuthFailure,
} from "./runner/remote-turn-auth.js";

import type { RuntimeRunCallbacks } from "./agent-runtime/types.js";
import type { RuntimeVoiceHistoryItem } from "../protocol/index.js";
import {
  getAgentRuntimeEngine,
  getReasoningEffort,
  getSubscriptionHarnessEnabled,
} from "./preferences/local-preferences.js";
import {
  resolveAgentEngineForRun,
  resolveSubscriptionHarnessRouteModel,
  sampleAgentEngineConfig,
} from "./runner/agent-model-config.js";

const VOICE_ORCHESTRATOR_HISTORY_LIMIT = 80;

const buildVoiceHistoryItems = (
  threadHistory:
    | Array<{
        timestamp?: number;
        role: string;
        content: string;
        toolCallId?: string;
      }>
    | undefined,
): RuntimeVoiceHistoryItem[] => {
  const entries = (threadHistory ?? []).slice(
    -VOICE_ORCHESTRATOR_HISTORY_LIMIT,
  );
  const history: RuntimeVoiceHistoryItem[] = [];
  for (const entry of entries) {
    const content = entry.content.trim();
    if (!content) continue;
    history.push({
      role: entry.role,
      content,
      ...(typeof entry.timestamp === "number" &&
      Number.isFinite(entry.timestamp)
        ? { timestamp: entry.timestamp }
        : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    });
  }
  return history;
};

export const createStellaHostRunner = (
  options: StellaHostRunnerOptions,
): RunnerPublicApi => {
  const context = createRunnerContext(options);
  const convexSession = createConvexSession(context);
  if (options.requestRuntimeAuthRefresh) {
    context.requestRuntimeAuthRefresh = async (payload) => {
      const result = await options.requestRuntimeAuthRefresh?.(payload);
      if (result?.token) {
        convexSession.setAuthToken(result.token);
      }
      if (result) {
        convexSession.setHasConnectedAccount(result.hasConnectedAccount);
      }
      return (
        result ?? {
          authenticated: false,
          token: null,
          hasConnectedAccount: false,
        }
      );
    };
  }
  context.state.webSearch = convexSession.webSearch;

  const storeOperations = createStoreOperations(context, {
    ensureStoreClient: convexSession.ensureStoreClient,
  });
  const buildAgentContextWithResolvedRoute = async (
    args:
      | Parameters<typeof buildAgentContext>[1]
      | Omit<Parameters<typeof buildAgentContext>[1], "resolvedLlm">,
  ) => {
    if ("resolvedLlm" in args && args.resolvedLlm) {
      return await buildAgentContext(context, args);
    }
    const configuredModel =
      args.model ??
      getConfiguredModel(
        context,
        args.agentType,
        resolveAgent(context, args.agentType),
      );
    const configuredAgentEngine = getAgentRuntimeEngine(context.stellaDataDir);
    const configuredReasoningEffort = getReasoningEffort(
      context.stellaDataDir,
      args.agentType,
    );
    const selectedEngine =
      args.modelConfigSnapshot?.engine ??
      resolveAgentEngineForRun(configuredAgentEngine, args.spawnEngine);
    const subscriptionHarnessEnabled = getSubscriptionHarnessEnabled(
      context.stellaDataDir,
      selectedEngine,
    );
    const sampledEngineConfig = args.modelConfigSnapshot
      ? undefined
      : sampleAgentEngineConfig({
          stellaDataDir: context.stellaDataDir,
          engine: selectedEngine,
          configuredModel,
          engineModelOverride: args.spawnEngine?.model,
          reasoningEffort:
            args.spawnReasoningEffort ?? configuredReasoningEffort,
        });
    const sampledSpawnEngine =
      selectedEngine === "default"
        ? args.spawnEngine
        : {
            engine: selectedEngine,
            ...(sampledEngineConfig?.engineModel
              ? { model: sampledEngineConfig.engineModel }
              : {}),
          };
    const subscriptionHarnessRouteModel = resolveSubscriptionHarnessRouteModel({
      stellaDataDir: context.stellaDataDir,
      agentType: args.agentType,
      configuredEngine: configuredAgentEngine,
      subscriptionHarnessEnabled,
      configuredModel,
      ...(sampledSpawnEngine ? { spawnEngine: sampledSpawnEngine } : {}),
      ...(args.modelConfigSnapshot
        ? { modelConfigSnapshot: args.modelConfigSnapshot }
        : {}),
    });
    const resolved = await resolveAgentModelRoute(
      context,
      args.agentType,
      subscriptionHarnessRouteModel ??
        ("modelConfigSnapshot" in args && args.modelConfigSnapshot
          ? args.modelConfigSnapshot.routeModel
          : "model" in args
            ? args.model
            : undefined),
      "modelConfigSnapshot" in args && args.modelConfigSnapshot
        ? AGENT_IDS.ORCHESTRATOR
        : args.agentType,
    );
    return await buildAgentContext(context, {
      ...args,
      ...resolved,
      configuredAgentEngine,
      configuredReasoningEffort,
      ...(sampledEngineConfig ? { sampledEngineConfig } : {}),
      subscriptionHarnessEnabled,
    });
  };
  const orchestratorController = createOrchestratorController(context, {
    buildAgentContext: buildAgentContextWithResolvedRoute,
    resolveAgent: (agentType) => resolveAgent(context, agentType),
    getConfiguredModel: (agentType, agent) =>
      getConfiguredModel(context, agentType, agent as never),
  });
  const taskOrchestration = createAgentOrchestration(context, {
    buildAgentContext: buildAgentContextWithResolvedRoute,
    sendMessage: orchestratorController.sendMessage,
  });

  // Restart-with-continuation: the LocalAgentManager the orchestration layer
  // just built has swept the durable thread rows that were `running` at the
  // previous shutdown. Convert a fresh shutdown record + that snapshot into
  // the one-shot interruption state (synchronously, before any user turn can
  // build a prompt), then schedule the boot-time continuation turn once the
  // runner finishes initializing. All guards (env gates, staleness,
  // idle-at-shutdown) live in the kernel module.
  const restartInterruptionState = convertRestartShutdownRecordAtBoot({
    stellaDataDir: context.stellaDataDir,
    env: process.env,
    interruptedThreads:
      context.state.localAgentManager?.getBootInterruptedThreads() ?? [],
    capturedEpisodeId:
      context.state.localAgentManager?.getBootInterruptionEpisodeId() ?? null,
  });
  if (restartInterruptionState) {
    void (async () => {
      // `start()` is called by the worker right after this factory returns;
      // wait for its initialization promise so the automation turn doesn't
      // bounce off the not-ready health check. Bounded poll — if start never
      // comes (unexpected), fire anyway and let the turn report not-ready.
      const deadline = Date.now() + 30_000;
      while (!context.state.initializationPromise && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      try {
        await context.state.initializationPromise;
      } catch {
        // Initialization failures surface elsewhere; the turn below will
        // report its own error if the runtime is truly unusable.
      }
      await fireRestartContinuationTurn({
        stellaDataDir: context.stellaDataDir,
        env: process.env,
        sentinels: {
          pausedReasons: [AGENT_PAUSE_CANCEL_REASON],
          restartCancelReasons: [
            AGENT_ORPHANED_RESTART_CANCEL_REASON,
            AGENT_SHUTDOWN_CANCEL_REASON,
          ],
        },
        getAgentRecord: (threadId) =>
          context.runtimeStore.getAgentRecord?.(threadId) ?? null,
        listAgentRecordsByStatus: (status) =>
          context.runtimeStore.listAgentRecordsByStatus?.(status) ?? [],
        appendLocalChatEvent: (args) => {
          context.appendLocalChatEvent?.(args);
        },
        runAutomationTurn: (args) =>
          orchestratorController.runAutomationTurn(args),
        log: (message, detail) => {
          console.warn(`[runner] ${message}`, detail ?? {});
        },
      });
    })().catch((error) => {
      console.warn(
        "[runner] restart-continuation boot fire failed",
        error instanceof Error ? error.message : error,
      );
    });
  }

  const warmModelCatalog = async (): Promise<void> => {
    await resolveAgentModelRoute(context, AGENT_IDS.ORCHESTRATOR);
  };

  const noopRuntimeCallbacks: RuntimeRunCallbacks = {
    onStream: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
    onEnd: () => {},
  };

  const runtimeInitialization = createRuntimeInitialization(context, {
    disposeConvexClient: convexSession.disposeConvexClient,
    shutdownTasks: taskOrchestration.shutdown,
  });

  return {
    deviceId: context.deviceId,
    hookEmitter: context.hookEmitter,
    setConvexUrl: convexSession.setConvexUrl,
    setConvexSiteUrl: convexSession.setConvexSiteUrl,
    setAuthToken: convexSession.setAuthToken,
    setHasConnectedAccount: convexSession.setHasConnectedAccount,
    setCloudSyncEnabled: convexSession.setCloudSyncEnabled,
    setModelCatalogUpdatedAt: convexSession.setModelCatalogUpdatedAt,
    start: runtimeInitialization.start,
    stop: runtimeInitialization.stop,
    waitUntilInitialized: async () => {
      if (context.state.initializationPromise) {
        await context.state.initializationPromise;
      }
    },
    subscribeQuery: convexSession.subscribeQuery,
    getConvexUrl: convexSession.getConvexUrl,
    getStellaSiteAuth: convexSession.getStellaSiteAuth,
    killAllShells: () => context.toolHost.killAllShells(),
    killShellsByPort: (port) => context.toolHost.killShellsByPort(port),
    executeTool: (toolName, toolArgs, toolContext, signal, onUpdate) =>
      context.toolHost.executeTool(
        toolName,
        toolArgs,
        toolContext,
        signal,
        onUpdate,
      ),
    agentHealthCheck: orchestratorController.agentHealthCheck,
    warmModelCatalog,
    resolveImageTarget: async (agentType = AGENT_IDS.ORCHESTRATOR) => {
      try {
        const { resolvedLlm } = await resolveAgentModelRoute(
          context,
          agentType,
        );
        return {
          provider: resolvedLlm.model.provider,
          api: resolvedLlm.model.api,
          modelId: resolvedLlm.model.id,
        };
      } catch {
        return null;
      }
    },
    webSearch: convexSession.webSearch,
    listStorePackages: storeOperations.listStorePackages,
    getStorePackage: storeOperations.getStorePackage,
    listStorePackageReleases: storeOperations.listStorePackageReleases,
    getStorePackageRelease: storeOperations.getStorePackageRelease,
    createFirstStoreRelease: storeOperations.createFirstStoreRelease,
    createStoreReleaseUpdate: storeOperations.createStoreReleaseUpdate,
    getStoreGitObjectUrls: storeOperations.getStoreGitObjectUrls,
    handleLocalChat: orchestratorController.handleLocalChat,
    sendMessage: orchestratorController.sendMessage,
    sendUserMessage: orchestratorController.sendUserMessage,
    runAutomationTurn: orchestratorController.runAutomationTurn,
    runBlockingLocalAgent: taskOrchestration.runBlockingLocalAgent,
    createBackgroundAgent: taskOrchestration.createBackgroundAgent,
    getActiveAgentCount: () =>
      context.state.localAgentManager?.getActiveAgentCount() ?? 0,
    listActiveAgentRuns: () =>
      context.state.localAgentManager?.listActiveAgentRuns() ?? [],
    getLocalAgentSnapshot: async (agentId: string) => {
      const manager = context.state.localAgentManager;
      if (!manager) {
        return null;
      }
      return manager.getAgent(agentId);
    },
    cancelLocalAgent: taskOrchestration.cancelLocalAgent,
    cancelLocalChat: orchestratorController.cancelLocalChat,
    cancelLocalChatByConversation:
      orchestratorController.cancelLocalChatByConversation,
    getActiveOrchestratorRun: orchestratorController.getActiveOrchestratorRun,
    appendThreadMessage: (args) => {
      context.runtimeStore.appendThreadMessage({
        ...args,
        timestamp: Date.now(),
      });
    },
    notifyOrchestratorHistoryChanged: (conversationId: string) => {
      context.state.orchestratorSessions
        .get(conversationId)
        ?.notifyHistoryChanged();
    },
    getVoiceOrchestratorConfig: async ({ conversationId }) => {
      const agentType = AGENT_IDS.ORCHESTRATOR;
      const runId = `voice-session:${Date.now()}`;
      const resolved = await resolveAgentModelRoute(context, agentType);
      const agentContext = await buildAgentContext(context, {
        conversationId,
        agentType,
        runId,
        ...resolved,
      });
      const instructions = await buildRuntimeSystemPrompt({
        runId,
        conversationId,
        userMessageId: runId,
        agentType,
        userPrompt: "",
        uiVisibility: "hidden",
        agentContext,
        callbacks: noopRuntimeCallbacks,
        toolExecutor: async () => ({ error: "Voice config has no executor." }),
        toolCatalog: context.toolHost.getToolCatalog(agentType, {
          model:
            resolved.resolvedLlm.toolPolicyModel ?? resolved.resolvedLlm.model,
          agentEngine: agentContext.agentEngine,
        }),
        deviceId: context.deviceId,
        stellaDataDir: context.stellaDataDir,
        resolvedLlm: resolved.resolvedLlm,
        store: context.runtimeStore,
        compactionScheduler: context.state.compactionScheduler,
        stellaAppDir: context.stellaAppDir,
        hookEmitter: context.hookEmitter,
      });
      const toolCatalog = context.toolHost.getToolCatalog(agentType, {
        model:
          resolved.resolvedLlm.toolPolicyModel ?? resolved.resolvedLlm.model,
        agentEngine: agentContext.agentEngine,
      });
      const history = buildVoiceHistoryItems(agentContext.threadHistory);
      return {
        instructions,
        tools: getRuntimeToolMetadata({
          toolsAllowlist: agentContext.toolsAllowlist,
          toolCatalog,
        }).map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        ...(history.length > 0 ? { history } : {}),
      };
    },
    convexAction: async (ref: unknown, args: unknown): Promise<unknown> => {
      const client = convexSession.ensureConvexClient();
      if (!client) {
        throw new Error(
          "Convex client not available — check connection and auth.",
        );
      }
      return (
        client as { action: (ref: unknown, args: unknown) => Promise<unknown> }
      ).action(ref, args);
    },

    triggerDreamNow: async (trigger = "manual") => {
      try {
        const { maybeSpawnDreamRun } = await import(
          "./agent-runtime/dream-scheduler.js"
        );
        const { resolveRunnerLlmRoute } = await import(
          "./runner/model-selection.js"
        );
        const { AGENT_IDS } = await import("../contracts/agent-runtime.js");
        const pendingItems =
          context.runtimeStore.dreamInboxStore.countUnprocessed();
        if (pendingItems === 0) {
          return {
            scheduled: false,
            reason: "no_inputs" as const,
            pendingItems,
          };
        }
        const dreamAgent = resolveAgent(context, AGENT_IDS.DREAM);
        const dreamModel = getConfiguredModel(
          context,
          AGENT_IDS.DREAM,
          dreamAgent,
        );
        const resolvedLlm = resolveRunnerLlmRoute(
          context,
          AGENT_IDS.DREAM,
          dreamModel,
        );
        return await maybeSpawnDreamRun({
          stellaDataDir: context.stellaDataDir,
          store: context.runtimeStore,
          resolvedLlm,
          trigger,
        });
      } catch (error) {
        console.warn("[runner] triggerDreamNow failed", error);
        return {
          scheduled: false,
          reason: "unavailable" as const,
          pendingItems: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    runChronicleSummaryTick: async (window) => {
      try {
        const { runChronicleSummary } = await import(
          "./memory/chronicle-summarizer.js"
        );
        const { resolveRunnerLlmRoute } = await import(
          "./runner/model-selection.js"
        );
        const { AGENT_IDS } = await import("../contracts/agent-runtime.js");
        const chronicleAgent = resolveAgent(context, AGENT_IDS.CHRONICLE);
        const chronicleModel = getConfiguredModel(
          context,
          AGENT_IDS.CHRONICLE,
          chronicleAgent,
        );
        const resolvedLlm = resolveRunnerLlmRoute(
          context,
          AGENT_IDS.CHRONICLE,
          chronicleModel,
        );
        return await runChronicleSummary({
          stellaDataDir: context.stellaDataDir,
          window,
          resolvedLlm,
          store: context.runtimeStore,
        });
      } catch (error) {
        console.warn("[runner] runChronicleSummaryTick failed", error);
        return {
          wrote: false,
          window,
          reason: "llm_failed" as const,
          uniqueLines: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
