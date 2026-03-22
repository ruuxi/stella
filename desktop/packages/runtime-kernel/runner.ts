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
  const convexSession = createConvexSession(context, {
    syncRemoteTurnBridge: () => syncRemoteTurnBridge(),
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
    isEnabled: () => context.state.isRunning && context.state.cloudSyncEnabled,
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
    runLocalTurn: async ({ conversationId, userPrompt, agentType }) =>
      await orchestratorController.runAutomationTurn({
        conversationId,
        userPrompt,
        agentType,
      }),
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
    if (
      !context.state.isRunning ||
      !context.state.isInitialized ||
      !context.state.cloudSyncEnabled
    ) {
      remoteTurnBridge.stop();
      return;
    }
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
  };
};
