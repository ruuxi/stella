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
import { loadGoogleWorkspaceTools } from "./google-workspace/load-google-workspace-tools.js";
import {
  deleteConnectorAccessTokens,
  loadConnectorAccessToken,
} from "./connectors/oauth.js";
import { AGENT_IDS } from "../contracts/agent-runtime.js";
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

import type { ToolResult } from "./tools/types.js";
import type { RuntimeRunCallbacks } from "./agent-runtime/types.js";
import type { RuntimeVoiceHistoryItem } from "../protocol/index.js";

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
  const entries = (threadHistory ?? []).slice(-VOICE_ORCHESTRATOR_HISTORY_LIMIT);
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

type GoogleWorkspaceAuthResult = {
  connected: boolean;
  unavailable?: boolean;
  email?: string;
  name?: string;
};

const getGoogleWorkspaceRecord = (
  value: unknown,
): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const getGoogleWorkspaceString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getGoogleWorkspacePrimaryArrayField = (
  value: unknown,
  fieldName: string,
): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const entry of value) {
    const record = getGoogleWorkspaceRecord(entry);
    const fieldValue = getGoogleWorkspaceString(record?.[fieldName]);
    if (fieldValue) {
      return fieldValue;
    }
  }

  return undefined;
};

export const parseGoogleWorkspaceProfile = (
  value: unknown,
): { email?: string; name?: string } => {
  const record = getGoogleWorkspaceRecord(value);
  if (!record) {
    return {};
  }

  return {
    email:
      getGoogleWorkspacePrimaryArrayField(record.emailAddresses, "value") ??
      getGoogleWorkspaceString(record.emailAddress) ??
      getGoogleWorkspaceString(record.email),
    name:
      getGoogleWorkspacePrimaryArrayField(record.names, "displayName") ??
      getGoogleWorkspacePrimaryArrayField(record.names, "unstructuredName") ??
      getGoogleWorkspaceString(record.displayName),
  };
};

const parseGoogleProfileResult = (
  result: ToolResult,
): GoogleWorkspaceAuthResult => {
  if ("error" in result) return { connected: false };
  const response = result.result;
  if (typeof response === "string") {
    try {
      const data = JSON.parse(response);
      return {
        connected: true,
        ...parseGoogleWorkspaceProfile(data),
      };
    } catch {
      return { connected: false };
    }
  }
  if (!response || typeof response !== "object") {
    return { connected: false };
  }
  return {
    connected: true,
    ...parseGoogleWorkspaceProfile(response),
  };
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
    const resolved = await resolveAgentModelRoute(
      context,
      args.agentType,
      "model" in args ? args.model : undefined,
    );
    return await buildAgentContext(context, {
      ...args,
      ...resolved,
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
          model: resolved.resolvedLlm.toolPolicyModel ?? resolved.resolvedLlm.model,
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
        model: resolved.resolvedLlm.toolPolicyModel ?? resolved.resolvedLlm.model,
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

    googleWorkspaceGetAuthStatus: async () => {
      return {
        connected: Boolean(
          await loadConnectorAccessToken(
            context.stellaDataDir,
            "google-workspace",
          ),
        ),
      };
    },

    googleWorkspaceConnect: async () => {
      const { callTool, disconnect } = await loadGoogleWorkspaceTools({
        stellaAppDir: context.stellaDataDir,
      });
      try {
        if (!callTool) return { connected: false, unavailable: true };
        return parseGoogleProfileResult(await callTool("people.getMe", {}));
      } finally {
        await disconnect().catch(() => undefined);
      }
    },

    googleWorkspaceDisconnect: async () => {
      await deleteConnectorAccessTokens(context.stellaDataDir, [
        "google-workspace",
      ]);
      return { ok: true };
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
