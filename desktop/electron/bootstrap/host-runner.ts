import path from "path";
import { Notification } from "electron";
import {
  getOrCreateDeviceIdentity,
  signDeviceHeartbeat,
} from "../../../runtime/kernel/home/device.js";
import type { SelfModHmrState } from "../../src/shared/contracts/boundary.js";
import {
  createStellaHostRunner,
  type RuntimeHostHandlers,
} from "../stella-host-runner.js";
import {
  type BootstrapContext,
  broadcastGoogleWorkspaceAuthRequired,
  broadcastLocalChatUpdated,
  broadcastScheduleUpdated,
  broadcastToWindows,
} from "./context.js";
import { startOfficePreviewBridge } from "./office-preview-bridge.js";
import { IPC_AUTH_RUNTIME_REFRESH_REQUESTED } from "../../src/shared/contracts/ipc-channels.js";

const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
};

const getRequiredFullWindow = (context: BootstrapContext) => {
  const window = context.state.windowManager?.getFullWindow() ?? null;
  if (!window || window.isDestroyed()) {
    throw new Error("Window not available");
  }
  return window;
};

export const buildHostRunnerUiActScript = (
  params: Parameters<RuntimeHostHandlers["uiAct"]>[0],
) =>
  params.action === "click"
    ? `window.__stellaUI?.handleCommand("click", [${JSON.stringify(params.ref)}])`
    : params.action === "fill"
      ? `window.__stellaUI?.handleCommand("fill", [${JSON.stringify(params.ref)}, ${JSON.stringify(params.value)}])`
      : `window.__stellaUI?.handleCommand("select", [${JSON.stringify(params.ref)}, ${JSON.stringify(params.value)}])`;

export const createHostRunnerHandlers = (
  context: BootstrapContext,
  options: {
    loadDeviceIdentity: () => Promise<
      Awaited<ReturnType<typeof getOrCreateDeviceIdentity>>
    >;
  },
): RuntimeHostHandlers => ({
  uiSnapshot: async () => {
    const window = getRequiredFullWindow(context);
    return String(
      await window.webContents.executeJavaScript(
        `window.__stellaUI?.snapshot?.() ?? "stella-ui handler not loaded"`,
      ),
    );
  },
  uiAct: async (params) => {
    const window = getRequiredFullWindow(context);
    return String(
      await window.webContents.executeJavaScript(
        `${buildHostRunnerUiActScript(params)} ?? "stella-ui handler not loaded"`,
      ),
    );
  },
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
        broadcastToWindows(context, IPC_AUTH_RUNTIME_REFRESH_REQUESTED, payload);
      },
    ),
  requestCredential: (payload) =>
    context.services.credentialService.requestCredential(payload),
  displayUpdate: (payload) => {
    // Forward the raw payload (string HTML or structured DisplayPayload
    // object) to all windows. The renderer normalizes both shapes via
    // `normalizeDisplayPayload`.
    broadcastToWindows(context, "display:update", payload);
  },
  showNotification: ({ title, body, sound }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body, sound, silent: false }).show();
    }
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
      await applyBatch({ suppressClientFullReload: canReload });
      if (canReload) {
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

  state.localChatUpdateUnsubscribe = runner.onLocalChatUpdated(() => {
    broadcastLocalChatUpdated(context);
  });
  state.scheduleUpdateUnsubscribe = runner.onScheduleUpdated(() => {
    broadcastScheduleUpdated(context);
  });
  state.googleWorkspaceAuthRequiredUnsubscribe = runner.onGoogleWorkspaceAuthRequired(() => {
    broadcastGoogleWorkspaceAuthRequired(context);
  });

  await runner.start();
  const health = await runner.client.health();
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
