import os from "node:os";
import { createRemoteTurnBridge } from "./remote-turn-bridge.js";
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
import { createTaskOrchestration } from "./runner/task-orchestration.js";
import type {
  RunnerPublicApi,
  StellaHostRunnerOptions,
} from "./runner/types.js";

export type { StellaHostRunnerOptions } from "./runner/types.js";

import type { ToolResult } from "./tools/types.js";

type GoogleWorkspaceAuthResult = {
  connected: boolean;
  unavailable?: boolean;
  email?: string;
  name?: string;
};

const DEVICE_HEARTBEAT_INTERVAL_MS = 30_000;
const REMOTE_TURN_AUTH_GRACE_MS = 15_000;
const REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS = 2;

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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

export const getConvexErrorCode = (error: unknown): string | null => {
  const directCode = asRecord(error)?.code;
  if (typeof directCode === "string" && directCode.trim()) {
    return directCode.trim();
  }

  const dataCode = asRecord(asRecord(error)?.data)?.code;
  if (typeof dataCode === "string" && dataCode.trim()) {
    return dataCode.trim();
  }

  return null;
};

export const isConvexUnauthenticatedError = (error: unknown): boolean =>
  getConvexErrorCode(error) === "UNAUTHENTICATED";

export const shouldStopRemoteTurnForAuthFailure = (args: {
  authWindowStartedAt: number;
  failureCount: number;
  nowMs: number;
}): boolean => {
  const withinGraceWindow =
    args.authWindowStartedAt > 0
    && args.nowMs - args.authWindowStartedAt <= REMOTE_TURN_AUTH_GRACE_MS;

  return !(
    withinGraceWindow
    && args.failureCount <= REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS
  );
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

/** True when a tool error looks like a missing/expired credential (polling should continue). */
const isAuthPendingError = (result: ToolResult): boolean =>
  "error" in result && AUTH_PENDING_PATTERN.test(result.error ?? "");

export const createStellaHostRunner = (
  options: StellaHostRunnerOptions,
): RunnerPublicApi => {
  const context = createRunnerContext(options);
  const deviceName = (() => {
    const hostname = os.hostname().trim();
    if (hostname) return hostname;
    return `${process.platform}-${context.deviceId.slice(0, 6)}`;
  })();

  let syncRemoteTurnBridge = () => {};
  let deviceRegistered = false;
  let deviceRegistering = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let remoteTurnAuthWindowStartedAt = 0;
  let remoteTurnUnauthenticatedFailures = 0;

  const stopHeartbeatLoop = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const resetRemoteTurnAuthTracking = () => {
    remoteTurnAuthWindowStartedAt = Date.now();
    remoteTurnUnauthenticatedFailures = 0;
  };

  const noteRemoteTurnAuthHealthy = () => {
    remoteTurnUnauthenticatedFailures = 0;
  };

  const stopRemoteTurnForPersistentAuthFailure = (
    source: "heartbeat" | "subscription" | "register",
    error: unknown,
  ): boolean => {
    if (!isConvexUnauthenticatedError(error)) {
      return false;
    }

    remoteTurnUnauthenticatedFailures += 1;
    if (
      !shouldStopRemoteTurnForAuthFailure({
        authWindowStartedAt: remoteTurnAuthWindowStartedAt,
        failureCount: remoteTurnUnauthenticatedFailures,
        nowMs: Date.now(),
      })
    ) {
      return true;
    }

    stopHeartbeatLoop();
    remoteTurnBridge.stop();
    deviceRegistered = false;
    deviceRegistering = false;
    remoteTurnUnauthenticatedFailures = 0;
    console.warn(
      `[remote-turn] ${source} auth failed; stopping remote turn sync until auth changes.`,
      error,
    );
    return true;
  };

  const sendHeartbeat = async (): Promise<void> => {
    if (
      !context.state.authToken
      || !context.state.hasConnectedAccount
      || !context.signHeartbeatPayload
    ) {
      return;
    }
    const client = convexSession.ensureConvexClient();
    if (!client) return;

    try {
      const signedAtMs = Date.now();
      const { publicKey, signature } =
        await context.signHeartbeatPayload(signedAtMs);
      await (client as any).mutation(
        (
          context.convexApi as {
            agent: { device_resolver: { heartbeat: unknown } };
          }
        ).agent.device_resolver.heartbeat,
        {
          deviceId: context.deviceId,
          deviceName,
          platform: process.platform,
          signedAtMs,
          signature,
          publicKey,
        },
      );
      deviceRegistered = true;
      noteRemoteTurnAuthHealthy();
    } catch (error) {
      if (stopRemoteTurnForPersistentAuthFailure("heartbeat", error)) {
        return;
      }
      console.warn("[remote-turn] Heartbeat failed:", error);
    }
  };

  const startHeartbeatLoop = () => {
    if (heartbeatTimer || !context.signHeartbeatPayload) return;
    heartbeatTimer = setInterval(() => {
      void sendHeartbeat();
    }, DEVICE_HEARTBEAT_INTERVAL_MS);
  };

  const registerDevice = async (attempt = 0): Promise<void> => {
    if (deviceRegistered || deviceRegistering) return;
    if (!context.state.authToken || !context.state.hasConnectedAccount) return;
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
          deviceName,
          platform: process.platform,
        },
      );
      deviceRegistered = true;
      noteRemoteTurnAuthHealthy();
    } catch (error) {
      if (stopRemoteTurnForPersistentAuthFailure("register", error)) {
        deviceRegistering = false;
        return;
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000));
        deviceRegistering = false;
        return registerDevice(attempt + 1);
      }
    }
    deviceRegistering = false;
  };

  let sendGoOffline: () => Promise<void> = async () => {};

  const convexSession = createConvexSession(context, {
    syncRemoteTurnBridge: () => syncRemoteTurnBridge(),
    onAuthTokenSet: () => {
      if (!context.state.hasConnectedAccount) {
        return;
      }
      void registerDevice();
    },
    onBeforeAuthTokenClear: () => sendGoOffline(),
  });

  sendGoOffline = async () => {
    stopHeartbeatLoop();
    if (!deviceRegistered) return;
    if (!context.state.authToken || !context.state.convexDeploymentUrl) {
      deviceRegistered = false;
      return;
    }
    const client = convexSession.ensureConvexClient();
    if (!client) return;

    try {
      await (client as any).mutation(
        (
          context.convexApi as {
            agent: { device_resolver: { goOffline: unknown } };
          }
        ).agent.device_resolver.goOffline,
        { deviceId: context.deviceId },
      );
      deviceRegistered = false;
    } catch {
      // best-effort
    }
  };
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
          noteRemoteTurnAuthHealthy();
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
        (error: Error) => {
          if (stopRemoteTurnForPersistentAuthFailure("subscription", error)) {
            return;
          }
          onError?.(error);
        },
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
      stopHeartbeatLoop();
      remoteTurnBridge.stop();
      void sendGoOffline();
      return;
    }
    if (!context.state.authToken || !context.state.convexDeploymentUrl) {
      stopHeartbeatLoop();
      remoteTurnBridge.stop();
      deviceRegistered = false;
      return;
    }
    if (!context.state.hasConnectedAccount) {
      stopHeartbeatLoop();
      remoteTurnBridge.stop();
      void sendGoOffline();
      return;
    }
    resetRemoteTurnAuthTracking();
    void registerDevice();
    startHeartbeatLoop();
    void sendHeartbeat();
    remoteTurnBridge.start();
    remoteTurnBridge.kick();
  };

  const runtimeInitialization = createRuntimeInitialization(context, {
    disposeConvexClient: convexSession.disposeConvexClient,
    syncRemoteTurnBridge,
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
  };
};
