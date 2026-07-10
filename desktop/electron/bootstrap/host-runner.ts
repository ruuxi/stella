import {
  getOrCreateDeviceIdentity,
  resetDeviceIdentity as resetStoredDeviceIdentity,
  signDeviceHeartbeat,
} from "../../../runtime/kernel/home/device.js";
import { getSoundNotificationsEnabled } from "../../../runtime/kernel/preferences/local-preferences.js";
import { ensureStellaDataDirSeeded } from "../../../runtime/kernel/home/stella-home.js";
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
import { getMainLogger } from "../observability/main-logger.js";

const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
};

// Module-level one-shot cache for the skills/agents home reconciliation. This
// seeding used to run on the pre-window path inside `resolveStellaDataDir`, where
// its ~100 awaited fs ops + sha256 over hundreds of KB contended with first
// paint. It only needs to complete before the runtime worker reads
// `~/.stella/skills` and `~/.stella/agents`, so we run it here — off first paint
// — before `connectHostRunner` spawns the worker.
//
// `initializeStellaHostRunner` also runs on host-runner reset flows; caching the
// first call's promise means resets don't re-pay the reconciliation. This is
// safe because a self-mod update that changes bundled skills/agents on disk
// implies a process restart (which resets this module state and re-seeds),
// so an in-process reset never needs to re-sync.
let stellaDataDirSeedingPromise: Promise<void> | null = null;

const ensureStellaDataDirSeededOnce = (
  stellaAppDir: string,
  stellaDataDirPath: string,
): Promise<void> => {
  if (!stellaDataDirSeedingPromise) {
    stellaDataDirSeedingPromise = ensureStellaDataDirSeeded(
      stellaAppDir,
      stellaDataDirPath,
    ).then(() => undefined);
  }
  return stellaDataDirSeedingPromise;
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
    const apps = (await listRecentApps(3)) ?? [];
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
  requestConnectorConnection: (payload) =>
    context.services.connectorConnectService.requestConnection(payload),
  cancelConnectorConnection: async (payload) =>
    context.services.connectorConnectService.cancelByOfferId(payload.offerId),
  requestBrowserExtensionConnect: (payload) =>
    context.services.connectorConnectService.requestBrowserExtensionConnect(
      payload,
    ),
  requestComputerUseAppApproval: (payload) =>
    context.services.securityPolicyService.ensureComputerUseAppApproval(
      payload,
    ),
  displayUpdate: (payload) => {
    // Forward structured DisplayPayload objects to all windows. The renderer
    // validates them before routing to the workspace panel.
    broadcastToWindows(context, "display:update", payload);
  },
  showNotification: ({ title, body, sound }) => {
    const stellaAppDir = context.state.stellaAppDir;
    const soundEnabled = stellaAppDir
      ? getSoundNotificationsEnabled(stellaAppDir)
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
    const suppressClientFullReload =
      requiresFullReload ||
      requiresRuntimeRestart === true ||
      requiresProcessRestart === true;
    try {
      const applyResult = await applyBatch({
        suppressClientFullReload,
      });
      if (
        (canReload ||
          (!suppressClientFullReload &&
            applyResult?.requiresClientFullReload === true)) &&
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

  const logger = getMainLogger();
  const connectBeganAt = Math.round(process.uptime() * 1000);
  logger?.process("startup.host-runner.connect", { elapsedMs: connectBeganAt });
  await runner.start();
  if (context.config.startupRuntimeWarmupDelayMs > 0) {
    logger?.process("startup.host-runner.worker-warmup-delayed", {
      delayMs: context.config.startupRuntimeWarmupDelayMs,
      elapsedMs: Math.round(process.uptime() * 1000),
    });
    const completed = await state.processRuntime.wait(
      context.config.startupRuntimeWarmupDelayMs,
    );
    if (!completed || state.isQuitting) {
      return;
    }
  }
  // Proactively spawn the worker (off the open burst, since connectHostRunner
  // runs from the deferred-startup sequence). The worker self-warms its model
  // catalog on init, so the first chat stays fast without a blocking warm.
  await runner.ensureWorkerStarted();
  const workerStartedAt = Math.round(process.uptime() * 1000);
  logger?.process("startup.host-runner.worker-spawned", {
    elapsedMs: workerStartedAt,
    sinceConnectMs: workerStartedAt - connectBeganAt,
  });
  const health = await runner.host.health();
  state.deviceId = health.deviceId;
  const readyAt = Math.round(process.uptime() * 1000);
  logger?.process("startup.host-runner.ready", {
    elapsedMs: readyAt,
    sinceConnectMs: readyAt - connectBeganAt,
  });
};

export const initializeStellaHostRunner = async (context: BootstrapContext) => {
  const { lifecycle, services, state } = context;
  const stellaAppDir = state.stellaAppDir;
  const stellaDataDirPath = state.stellaDataDirPath;
  if (!stellaAppDir || !stellaDataDirPath || !state.stellaWorkspacePath) {
    throw new Error("Stella root is not initialized.");
  }

  // Reconcile bundled skills/agents into the home dir before the worker
  // (spawned by connectHostRunner -> runner.start()/ensureWorkerStarted) reads
  // them. One-shot cached so host-runner resets don't re-pay it.
  await ensureStellaDataDirSeededOnce(stellaAppDir, stellaDataDirPath);

  await services.securityPolicyService.loadPolicy();

  const loadDeviceIdentity = async () =>
    await getOrCreateDeviceIdentity(stellaDataDirPath);
  const resetDeviceIdentity = async () =>
    await resetStoredDeviceIdentity(stellaDataDirPath);

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
        stellaAppDir,
        stellaDataDirPath,
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
