import {
  buildAgentContext,
  createRunnerContext,
  getConfiguredModel,
  resolveAgent,
} from "./runner/context.js";
import { createConvexSession } from "./runner/convex-session.js";
import { createOrchestratorController } from "./runner/orchestrator.js";
import { createRuntimeInitialization } from "./runner/runtime-initialization.js";
import { createStoreOperations } from "./runner/store-operations.js";
import { createAgentOrchestration } from "./runner/agent-orchestration.js";
import type {
  RunnerPublicApi,
  StellaHostRunnerOptions,
} from "./runner/types.js";

export type { StellaHostRunnerOptions } from "./runner/types.js";
export {
  getConvexErrorCode,
  isConvexUnauthenticatedError,
  REMOTE_TURN_AUTH_GRACE_MS,
  REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS,
  shouldStopRemoteTurnForAuthFailure,
} from "./runner/remote-turn-auth.js";

import type { ToolResult } from "./tools/types.js";

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

const AUTH_PENDING_PATTERN = /\bauth\b|oauth|sign[._-]?in|login|consent|credential|unauthorized|unauthenticated|\b403\b|\b401\b/i;

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

/** True when a tool error looks like a missing/expired credential (polling should continue). */
const isAuthPendingError = (result: ToolResult): boolean =>
  "error" in result && AUTH_PENDING_PATTERN.test(result.error ?? "");

export const createStellaHostRunner = (
  options: StellaHostRunnerOptions,
): RunnerPublicApi => {
  const context = createRunnerContext(options);
  const convexSession = createConvexSession(context);

  const storeOperations = createStoreOperations(context, {
    ensureStoreClient: convexSession.ensureStoreClient,
  });
  const orchestratorController = createOrchestratorController(context, {
    buildAgentContext: (args) => buildAgentContext(context, args),
    resolveAgent: (agentType) => resolveAgent(context, agentType),
    getConfiguredModel: (agentType, agent) =>
      getConfiguredModel(context, agentType, agent as never),
    webSearch: convexSession.webSearch,
  });
  const taskOrchestration = createAgentOrchestration(context, {
    buildAgentContext: (args) => buildAgentContext(context, args),
    sendMessage: orchestratorController.sendMessage,
    webSearch: convexSession.webSearch,
  });

  const runtimeInitialization = createRuntimeInitialization(context, {
    disposeConvexClient: convexSession.disposeConvexClient,
    shutdownTasks: taskOrchestration.shutdown,
    onGoogleWorkspaceAuthRequired: options.onGoogleWorkspaceAuthRequired,
  });
  context.ensureGoogleWorkspaceToolsLoaded =
    runtimeInitialization.ensureGoogleWorkspaceToolsLoaded;

  return {
    deviceId: context.deviceId,
    hookEmitter: context.hookEmitter,
    setConvexUrl: convexSession.setConvexUrl,
    setConvexSiteUrl: convexSession.setConvexSiteUrl,
    setAuthToken: convexSession.setAuthToken,
    setHasConnectedAccount: convexSession.setHasConnectedAccount,
    setCloudSyncEnabled: convexSession.setCloudSyncEnabled,
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
    webSearch: convexSession.webSearch,
    listStorePackages: storeOperations.listStorePackages,
    getStorePackage: storeOperations.getStorePackage,
    listStorePackageReleases: storeOperations.listStorePackageReleases,
    getStorePackageRelease: storeOperations.getStorePackageRelease,
    createFirstStoreRelease: storeOperations.createFirstStoreRelease,
    createStoreReleaseUpdate: storeOperations.createStoreReleaseUpdate,
    handleLocalChat: orchestratorController.handleLocalChat,
    sendMessage: orchestratorController.sendMessage,
    sendUserMessage: orchestratorController.sendUserMessage,
    runAutomationTurn: orchestratorController.runAutomationTurn,
    runBlockingLocalAgent: taskOrchestration.runBlockingLocalAgent,
    createBackgroundAgent: taskOrchestration.createBackgroundAgent,
    getActiveAgentCount: () =>
      context.state.localAgentManager?.getActiveAgentCount() ?? 0,
    getLocalAgentSnapshot: async (agentId: string) => {
      const manager = context.state.localAgentManager;
      if (!manager) {
        return null;
      }
      return manager.getAgent(agentId);
    },
    cancelLocalChat: orchestratorController.cancelLocalChat,
    getActiveOrchestratorRun: orchestratorController.getActiveOrchestratorRun,
    resumeSelfModHmr: async (
      runId: string,
      options?: { suppressClientFullReload?: boolean },
    ) => Boolean(await context.selfModHmrController?.resume(runId, options)),
    appendThreadMessage: (args) => {
      context.runtimeStore.appendThreadMessage({
        ...args,
        timestamp: Date.now(),
      });
    },
    convexAction: async (ref: unknown, args: unknown): Promise<unknown> => {
      const client = convexSession.ensureConvexClient();
      if (!client) {
        throw new Error("Convex client not available — check connection and auth.");
      }
      return (client as { action: (ref: unknown, args: unknown) => Promise<unknown> }).action(ref, args);
    },

    googleWorkspaceGetAuthStatus: async () => {
      await context.ensureGoogleWorkspaceToolsLoaded();
      const callTool = context.state.googleWorkspaceCallTool;
      if (!callTool) return { connected: false, unavailable: true };
      // Return cached auth state. Calling any auth-dependent tool would trigger the
      // upstream OAuth browser flow when not authenticated, so we never probe
      // here — state is updated passively by callGoogleWorkspaceTool.
      return { connected: context.state.googleWorkspaceAuthenticated === true };
    },

    googleWorkspaceConnect: async () => {
      await context.ensureGoogleWorkspaceToolsLoaded();
      const callTool = context.state.googleWorkspaceCallTool;
      if (!callTool) return { connected: false, unavailable: true };
      // Trigger the upstream OAuth browser flow.
      const initial = await callTool("people.getMe", {});
      const initialParsed = parseGoogleProfileResult(initial);
      if (initialParsed.connected) return initialParsed;
      // Only poll if the error looks auth-related (consent pending). Fail fast on
      // hard errors like network failures or adapter crashes.
      if (!isAuthPendingError(initial)) return { connected: false };
      const maxAttempts = 60;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const result = await callTool("people.getMe", {});
        const status = parseGoogleProfileResult(result);
        if (status.connected) return status;
        if (!isAuthPendingError(result)) return { connected: false };
      }
      return { connected: false };
    },

    googleWorkspaceDisconnect: async () => {
      await context.ensureGoogleWorkspaceToolsLoaded();
      const callTool = context.state.googleWorkspaceCallTool;
      if (!callTool) return { ok: false };
      const result = await callTool("auth.clear", {});
      const ok = !("error" in result);
      if (ok) {
        context.state.googleWorkspaceAuthenticated = false;
      }
      return { ok };
    },

    triggerDreamNow: async (trigger = "manual") => {
      try {
        const { countPendingDreamExtensions } = await import(
          "./memory/dream-core.js"
        );
        const { maybeSpawnDreamRun } = await import(
          "./agent-runtime/dream-scheduler.js"
        );
        const { resolveRunnerLlmRoute } = await import(
          "./runner/model-selection.js"
        );
        const { AGENT_IDS } = await import(
          "../../desktop/src/shared/contracts/agent-runtime.js"
        );
        const pendingThreadSummaries =
          context.runtimeStore.threadSummariesStore.countUnprocessed();
        const pendingExtensions = await countPendingDreamExtensions(
          context.stellaRoot,
        );
        if (pendingThreadSummaries + pendingExtensions === 0) {
          return {
            scheduled: false,
            reason: "no_inputs" as const,
            pendingThreadSummaries,
            pendingExtensions,
          };
        }
        const resolvedLlm = resolveRunnerLlmRoute(
          context,
          AGENT_IDS.DREAM,
          undefined,
        );
        return await maybeSpawnDreamRun({
          stellaHome: context.stellaRoot,
          store: context.runtimeStore,
          resolvedLlm,
          trigger,
        });
      } catch (error) {
        console.warn("[runner] triggerDreamNow failed", error);
        return {
          scheduled: false,
          reason: "unavailable" as const,
          pendingThreadSummaries: 0,
          pendingExtensions: 0,
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
        const { AGENT_IDS } = await import(
          "../../desktop/src/shared/contracts/agent-runtime.js"
        );
        const resolvedLlm = resolveRunnerLlmRoute(
          context,
          AGENT_IDS.CHRONICLE,
          undefined,
        );
        return await runChronicleSummary({
          stellaHome: context.stellaRoot,
          window,
          resolvedLlm,
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
