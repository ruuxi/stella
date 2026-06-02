import { BrowserWindow } from "electron";
import {
  getOrCreateDeviceIdentity,
  resetDeviceIdentity as resetStoredDeviceIdentity,
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
  broadcastLocalChatUpdated,
  broadcastScheduleUpdated,
  broadcastToWindows,
} from "./context.js";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";
import { IPC_AUTH_RUNTIME_REFRESH_REQUESTED } from "../../src/shared/contracts/ipc-channels.js";
import { showStellaNotification } from "../services/notification-service.js";
import { getActiveBrowserTabForBundleId } from "../active-browser-tab.js";
import { listRecentApps } from "../recent-apps.js";
import { requestMacPermission } from "../utils/macos-permissions.js";

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
    resetDeviceIdentity: () => Promise<
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
  resetDeviceIdentity: async () => {
    const identity = await options.resetDeviceIdentity();
    context.state.deviceId = identity.deviceId;
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
  getAppBrowserContext: async () => {
    const apps = (await listRecentApps(8)) ?? [];
    const activeApp = apps.find((app) => app.isActive && app.bundleId);
    const activeBrowserTab = activeApp?.bundleId
      ? await getActiveBrowserTabForBundleId(activeApp.bundleId)
      : null;
    return {
      apps: apps.map((app) => ({
        name: app.name,
        pid: app.pid,
        isActive: app.isActive,
        ...(app.bundleId ? { bundleId: app.bundleId } : {}),
        ...(app.windowTitle ? { windowTitle: app.windowTitle } : {}),
      })),
      activeBrowserTab,
    };
  },
  requestCredential: (payload) =>
    context.services.credentialService.requestCredential(payload),
  requestConnectorCredential: (payload) =>
    payload.preregisteredOAuth
      ? context.services.connectorCredentialService.requestPreregisteredOAuth({
          tokenKey: payload.tokenKey,
          displayName: payload.displayName,
          description: payload.description,
          ...payload.preregisteredOAuth,
        })
      : context.services.connectorCredentialService.requestCredential(payload),
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
  requestDesktopPermission: async (kind) => requestMacPermission(kind),
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
    requiresRuntimeRestart,
    requiresProcessRestart,
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
        requiresRuntimeRestart,
        requiresProcessRestart,
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
    // Vite's raw full-reload is a browser navigation, not the Electron hard
    // reload self-mod needs. Always latch it in the Vite endpoint and let the
    // host perform reloadIgnoringCache under the morph cover.
    const suppressClientFullReload = true;
    try {
      const applyResult = await applyBatch({
        suppressClientFullReload,
      });
      if (
        (canReload ||
          applyResult?.requiresClientFullReload === true) &&
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
  state.scheduleUpdateUnsubscribe?.();
  state.scheduleUpdateUnsubscribe = null;
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
  state.scheduleUpdateUnsubscribe = runner.onScheduleUpdated(() => {
    broadcastScheduleUpdated(context);
  });

  await runner.start();
  if (state.appReady && BrowserWindow.getFocusedWindow()) {
    runner.setHostFocused(true);
  } else {
    runner.setHostFocused(false);
  }
  const health = await runner.host.health();
  state.deviceId = health.deviceId;
};

export const initializeStellaHostRunner = async (context: BootstrapContext) => {
  const { lifecycle, services, state } = context;
  const stellaRoot = state.stellaRoot;
  const stellaHomePath = state.stellaHomePath;
  if (!stellaRoot || !stellaHomePath || !state.stellaWorkspacePath) {
    throw new Error("Stella root is not initialized.");
  }

  await services.securityPolicyService.loadPolicy();

  const loadDeviceIdentity = async () =>
    await getOrCreateDeviceIdentity(stellaHomePath);
  const resetDeviceIdentity = async () =>
    await resetStoredDeviceIdentity(stellaHomePath);

  clearHostRunnerSubscriptions(context);
  context.state.officePreviewBridgeStop?.();
  context.state.officePreviewBridgeStop = null;
  await lifecycle.getRunner()?.stop();
  lifecycle.setRunner(
    createStellaHostRunner({
      initializeParams: {
        clientName: "stella-electron-host",
        clientVersion: "0.0.0",
        isDev: context.config.useDevServer,
        platform: process.platform,
        stellaRoot,
        stellaHomePath,
        stellaWorkspacePath: state.stellaWorkspacePath,
      },
      hostHandlers: createHostRunnerHandlers(context, {
        loadDeviceIdentity,
        resetDeviceIdentity,
      }),
    }),
  );

  await connectHostRunner(context);
  if (state.appReady && !state.officePreviewBridgeStop) {
    state.officePreviewBridgeStop = startOfficePreviewBridge(context);
  }
};
