import { createRemoteTurnBridge } from "./remote-turn-bridge.js";
import {
  buildAgentContext,
  createRunnerContext,
  getConfiguredModel,
  refreshLoadedSkills,
  resolveAgent,
} from "./runner/context.js";
import { createConvexSession } from "./runner/convex-session.js";
import { createOrchestratorController } from "./runner/orchestrator.js";
import { createRuntimeInitialization } from "./runner/runtime-initialization.js";
import { createStoreOperations } from "./runner/store-operations.js";
import { createTaskOrchestration } from "./runner/task-orchestration.js";
import type {
  RunnerPublicApi,
  StellaHostRunnerOptions,
} from "./runner/types.js";

export type { StellaHostRunnerOptions } from "./runner/types.js";

export const createStellaHostRunner = (
  options: StellaHostRunnerOptions,
): RunnerPublicApi => {
  const context = createRunnerContext(options);

  let syncRemoteTurnBridge = () => {};
  let deviceRegistered = false;
  let deviceRegistering = false;

  const registerDevice = async (attempt = 0): Promise<void> => {
    if (deviceRegistered || deviceRegistering) return;
    if (!context.state.authToken) return;
    const client = convexSession.ensureConvexClient();
    if (!client) return;

    deviceRegistering = true;
    // Give the Convex client time to authenticate
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (deviceRegistered) {
      deviceRegistering = false;
      return;
    }

    try {
      await (client as any).mutation(
        (
          context.convexApi as {
            agent: { device_resolver: { registerDevice: unknown } };
          }
        ).agent.device_resolver.registerDevice,
        {
          deviceId: context.deviceId,
          platform: process.platform,
        },
      );
      deviceRegistered = true;
    } catch {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000));
        deviceRegistering = false;
        return registerDevice(attempt + 1);
      }
    }
    deviceRegistering = false;
  };

  const sendGoOffline = async () => {
    if (!deviceRegistered) return;
    const client = convexSession.ensureConvexClient();
    if (!client) return;

    try {
      await (client as any).mutation(
        (
          context.convexApi as {
            agent: { device_resolver: { goOffline: unknown } };
          }
        ).agent.device_resolver.goOffline,
        {},
      );
      deviceRegistered = false;
    } catch {
      // best-effort
    }
  };

  const convexSession = createConvexSession(context, {
    syncRemoteTurnBridge: () => syncRemoteTurnBridge(),
    onAuthTokenSet: () => void registerDevice(),
  });
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
  const taskOrchestration = createTaskOrchestration(context, {
    buildAgentContext: (args) => buildAgentContext(context, args),
    queueOrchestratorTurn: orchestratorController.queueOrchestratorTurn,
    startStreamingOrchestratorTurn:
      orchestratorController.startStreamingOrchestratorTurn,
    webSearch: convexSession.webSearch,
  });

  const remoteTurnBridge = createRemoteTurnBridge({
    deviceId: context.deviceId,
    isEnabled: () => context.state.isRunning,
    isRunnerBusy: () => false,
    subscribeRemoteTurnRequests: ({
      deviceId: targetDeviceId,
      since,
      onUpdate,
      onError,
    }) => {
      const client = convexSession.ensureConvexClient();
      if (!client) {
        return () => {};
      }

      const subscription = (client as any).onUpdate(
        (
          context.convexApi as {
            events: { subscribeRemoteTurnRequestsForDevice: unknown };
          }
        ).events.subscribeRemoteTurnRequestsForDevice,
        {
          deviceId: targetDeviceId,
          since,
          limit: 20,
        },
        (events: unknown) => {
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
        onError,
      );

      return () => {
        subscription.unsubscribe();
      };
    },
    runLocalTurn: async ({ conversationId, userPrompt, agentType }) => {
      const localConversationId =
        context.getDefaultConversationId?.() ?? conversationId;
      context.appendLocalChatEvent?.({
        conversationId: localConversationId,
        type: "user_message",
        payload: { text: userPrompt, source: "connector" },
      });
      const result = await orchestratorController.runAutomationTurn({
        conversationId: localConversationId,
        userPrompt,
        agentType,
      });
      if (result.status === "ok" && result.finalText) {
        context.appendLocalChatEvent?.({
          conversationId: localConversationId,
          type: "assistant_message",
          payload: { text: result.finalText, source: "connector" },
        });
      }
      return result;
    },
    claimRemoteTurn: async ({ requestId, conversationId }) => {
      const client = convexSession.ensureConvexClient();
      if (!client) return;
      await (client as any).mutation(
        (
          context.convexApi as {
            channels: { connector_delivery: { claimRemoteTurn: unknown } };
          }
        ).channels.connector_delivery.claimRemoteTurn,
        { requestId, conversationId },
      );
    },
    completeConnectorTurn: async ({ requestId, conversationId, text }) => {
      const client = convexSession.ensureConvexClient();
      if (!client) {
        throw new Error("Missing Convex client configuration.");
      }
      await (client as any).mutation(
        (
          context.convexApi as {
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

  syncRemoteTurnBridge = () => {
    if (!context.state.isRunning || !context.state.isInitialized) {
      remoteTurnBridge.stop();
      void sendGoOffline();
      return;
    }
    if (!context.state.authToken || !context.state.convexDeploymentUrl) {
      // Not ready yet — will be called again when auth/url arrive
      return;
    }
    void registerDevice();
    remoteTurnBridge.start();
    remoteTurnBridge.kick();
  };

  const runtimeInitialization = createRuntimeInitialization(context, {
    refreshLoadedSkills: () => refreshLoadedSkills(context),
    disposeConvexClient: convexSession.disposeConvexClient,
    syncRemoteTurnBridge,
    shutdownTasks: taskOrchestration.shutdown,
  });

  return {
    deviceId: context.deviceId,
    hookEmitter: context.hookEmitter,
    setConvexUrl: convexSession.setConvexUrl,
    setAuthToken: convexSession.setAuthToken,
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
    getProxy: convexSession.getProxy,
    killAllShells: () => context.toolHost.killAllShells(),
    killShellsByPort: (port) => context.toolHost.killShellsByPort(port),
    executeTool: (toolName, toolArgs, toolContext) =>
      context.toolHost.executeTool(toolName, toolArgs, toolContext),
    agentHealthCheck: orchestratorController.agentHealthCheck,
    webSearch: convexSession.webSearch,
    listStorePackages: storeOperations.listStorePackages,
    getStorePackage: storeOperations.getStorePackage,
    listStorePackageReleases: storeOperations.listStorePackageReleases,
    getStorePackageRelease: storeOperations.getStorePackageRelease,
    createFirstStoreRelease: storeOperations.createFirstStoreRelease,
    createStoreReleaseUpdate: storeOperations.createStoreReleaseUpdate,
    handleLocalChat: orchestratorController.handleLocalChat,
    runAutomationTurn: orchestratorController.runAutomationTurn,
    runBlockingLocalTask: taskOrchestration.runBlockingLocalTask,
    createBackgroundTask: taskOrchestration.createBackgroundTask,
    getActiveTaskCount: () => context.state.localTaskManager?.getTaskCount() ?? 0,
    getLocalTaskSnapshot: async (taskId: string) => {
      const manager = context.state.localTaskManager;
      if (!manager) {
        return null;
      }
      return manager.getTask(taskId);
    },
    cancelLocalChat: orchestratorController.cancelLocalChat,
    getActiveOrchestratorRun: orchestratorController.getActiveOrchestratorRun,
    resumeSelfModHmr: async (
      runId: string,
      options?: { suppressClientFullReload?: boolean },
    ) => Boolean(await context.selfModHmrController?.resume(runId, options)),
    recoverCrashedRuns: runtimeInitialization.recoverCrashedRuns,
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
  };
};
