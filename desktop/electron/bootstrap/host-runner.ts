import path from "path";
import { BrowserWindow } from "electron";
import {
  getOrCreateDeviceIdentity,
  signDeviceHeartbeat,
} from "../../../runtime/kernel/home/device.js";
import { getSoundNotificationsEnabled } from "../../../runtime/kernel/preferences/local-preferences.js";
import type { SelfModHmrState } from "../../../runtime/contracts/index.js";
import {
  createStellaHostRunner,
  type RuntimeHostHandlers,
} from "../stella-host-runner.js";
import {
  type BootstrapContext,
  broadcastGoogleWorkspaceAuthRequired,
  broadcastLocalChatUpdated,
  broadcastScheduleUpdated,
  broadcastStoreThreadUpdated,
  broadcastToWindows,
} from "./context.js";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";
import { IPC_AUTH_RUNTIME_REFRESH_REQUESTED } from "../../src/shared/contracts/ipc-channels.js";
import { showStellaNotification } from "../services/notification-service.js";

const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
};

export const createHostRunnerHandlers = (
  context: BootstrapContext,
  options: {
    loadDeviceIdentity: () => Promise<
      Awaited<ReturnType<typeof getOrCreateDeviceIdentity>>
    >;
  },
): RuntimeHostHandlers => ({
  getActiveConversationId: () =>
    context.services.uiStateService.state.conversationId?.trim() || null,
  getDeviceIdentity: async () => {
    const identity = await options.loadDeviceIdentity();
    return {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
    };
  },
  signHeartbeatPayload: async (signedAtMs) => {
    const identity = await options.loadDeviceIdentity();
    return {
      publicKey: identity.publicKey,
      signature: signDeviceHeartbeat(identity, signedAtMs),
    };
  },
  requestRuntimeAuthRefresh: async ({ source }) =>
    await context.services.authService.requestRuntimeAuthRefresh(
      source,
      (payload) => {
        broadcastToWindows(
          context,
          IPC_AUTH_RUNTIME_REFRESH_REQUESTED,
          payload,
        );
      },
    ),
  requestCredential: (payload) =>
    context.services.credentialService.requestCredential(payload),
  requestConnectorCredential: (payload) =>
    context.services.connectorCredentialService.requestCredential(payload),
  displayUpdate: (payload) => {
    // Forward structured DisplayPayload objects to all windows. The renderer
    // validates them before routing to the workspace panel.
    broadcastToWindows(context, "display:update", payload);
  },
  showNotification: ({ title, body, sound }) => {
    const stellaRoot = context.state.stellaRoot;
    const soundEnabled = stellaRoot
      ? getSoundNotificationsEnabled(stellaRoot)
      : true;
    showStellaNotification(context, {
      id: `stella-runtime-${Date.now()}`,
      groupId: "stella-runtime",
      groupTitle: "Stella",
      title,
      body,
      sound: soundEnabled ? sound : undefined,
      silent: !soundEnabled,
    });
  },
  openExternal: async (url) => {
    context.services.externalLinkService.openSafeExternalUrl(url);
  },
  showWindow: async (target) => {
    context.state.windowManager?.showWindow(target);
  },
  focusWindow: async (target) => {
    const window =
      target === "mini"
        ? context.state.windowManager?.getMiniWindow()
        : context.state.windowManager?.getFullWindow();
    window?.focus();
  },
  runHmrTransition: async ({
    runIds,
    stateRunIds,
    requiresFullReload,
    applyBatch,
    reportState,
  }) => {
    if (context.state.hmrTransitionController) {
      await context.state.hmrTransitionController.runTransition({
        runIds,
        stateRunIds,
        applyBatch,
        reportState,
        requiresFullReload,
      });
      return;
    }
    reportState?.({
      phase: requiresFullReload ? "reloading" : "applying",
      paused: false,
      requiresFullReload,
    });
    const fullWindow = context.state.windowManager?.getFullWindow() ?? null;
    const canReload =
      requiresFullReload && fullWindow != null && !fullWindow.isDestroyed();
    try {
      const applyResult = await applyBatch({
        suppressClientFullReload: canReload,
      });
      if (
        (canReload || applyResult?.requiresClientFullReload === true) &&
        fullWindow != null &&
        !fullWindow.isDestroyed()
      ) {
        fullWindow.webContents.reloadIgnoringCache();
      }
    } finally {
      reportState?.(IDLE_HMR_STATE);
    }
  },
});

const clearHostRunnerSubscriptions = (context: BootstrapContext) => {
  const { state } = context;

  state.localChatUpdateUnsubscribe?.();
  state.localChatUpdateUnsubscribe = null;
  state.storeThreadUpdateUnsubscribe?.();
  state.storeThreadUpdateUnsubscribe = null;
  state.scheduleUpdateUnsubscribe?.();
  state.scheduleUpdateUnsubscribe = null;
  state.googleWorkspaceAuthRequiredUnsubscribe?.();
  state.googleWorkspaceAuthRequiredUnsubscribe = null;
};

const connectHostRunner = async (context: BootstrapContext) => {
  const { lifecycle, services, state } = context;
  const runner = lifecycle.getRunner();

  if (!runner) {
    throw new Error("Host runner did not initialize.");
  }

  const pendingConvexUrl = services.authService.getPendingConvexUrl();
  if (pendingConvexUrl) {
    runner.setConvexUrl(pendingConvexUrl);
  }
  runner.setConvexSiteUrl(services.authService.getConvexSiteUrl());
  runner.setHasConnectedAccount(
    services.authService.getHostHasConnectedAccount(),
  );
  runner.setAuthToken(await services.authService.getAuthToken());

  state.localChatUpdateUnsubscribe = runner.onLocalChatUpdated((payload) => {
    broadcastLocalChatUpdated(context, payload);
  });
  state.storeThreadUpdateUnsubscribe = runner.onStoreThreadUpdated(
    (snapshot) => {
      broadcastStoreThreadUpdated(context, snapshot);
    },
  );
  state.scheduleUpdateUnsubscribe = runner.onScheduleUpdated(() => {
    broadcastScheduleUpdated(context);
  });
  state.googleWorkspaceAuthRequiredUnsubscribe =
    runner.onGoogleWorkspaceAuthRequired(() => {
      broadcastGoogleWorkspaceAuthRequired(context);
    });

  await runner.start();
  if (BrowserWindow.getFocusedWindow()) {
    await runner.warmWorker().catch((error) => {
      console.warn("[stella-runtime] Initial worker warm failed:", error);
    });
  } else {
    runner.setHostFocused(false);
  }
  const health = await runner.host.health();
  state.deviceId = health.deviceId;
};

export const initializeStellaHostRunner = async (context: BootstrapContext) => {
  const { lifecycle, services, state } = context;
  const stellaRoot = state.stellaRoot;
  if (!stellaRoot || !state.stellaWorkspacePath) {
    throw new Error("Stella root is not initialized.");
  }

  await services.securityPolicyService.loadPolicy();

  const loadDeviceIdentity = async () =>
    await getOrCreateDeviceIdentity(path.join(stellaRoot, "state"));

  clearHostRunnerSubscriptions(context);
  context.state.officePreviewBridgeStop?.();
  context.state.officePreviewBridgeStop = null;
  await lifecycle.getRunner()?.stop();
  lifecycle.setRunner(
    createStellaHostRunner({
      initializeParams: {
        clientName: "stella-electron-host",
        clientVersion: "0.0.0",
        isDev: context.config.isDev,
        platform: process.platform,
        stellaRoot,
        stellaWorkspacePath: state.stellaWorkspacePath,
      },
      hostHandlers: createHostRunnerHandlers(context, { loadDeviceIdentity }),
    }),
  );

  await connectHostRunner(context);
  context.state.officePreviewBridgeStop = startOfficePreviewBridge(context);
};
