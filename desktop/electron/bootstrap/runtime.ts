import { app, BrowserWindow } from "electron";
import path from "path";
import { getDevServerUrl } from "../dev-url.js";
import { registerBootstrapIpcHandlers } from "./ipc.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { createStellaHostRunner } from "../stella-host-runner.js";
import { getSelectedText, initSelectedTextProcess } from "../selected-text.js";
import { LocalSchedulerService } from "../services/local-scheduler-service.js";
import { createDesktopDatabase } from "../storage/database.js";
import { ChatStore } from "../storage/chat-store.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { StoreModStore } from "../storage/store-mod-store.js";
import { SocialSessionStore } from "../storage/social-session-store.js";
import { TranscriptMirror } from "../storage/transcript-mirror.js";
import {
  getOrCreateDeviceIdentity,
  signDeviceHeartbeat,
} from "../system/device.js";
import { resolveStellaHome } from "../system/stella-home.js";
import { initializeWakeWord } from "../wake-word/initialize.js";
import { startStellaUiServer } from "../system/stella-ui-server.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrMorphOrchestrator } from "../self-mod/hmr-morph.js";
import { StoreModService } from "../self-mod/store-mod-service.js";
import { createBootstrapResetFlows, shutdownBootstrapRuntime } from "./resets.js";
import { MobileBridgeService } from "../services/mobile-bridge/service.js";
import { emitStartupMetric } from "../startup/profiler.js";
import {
  type BootstrapContext,
  broadcastAuthCallback,
  broadcastWakeWordState,
  getMobileBroadcast,
} from "./context.js";
import { DevToolServer } from "../devtool/dev-server.js";

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const POST_WINDOW_AUX_START_DELAY_MS = 1_500;

const startMobileBridge = (context: BootstrapContext) => {
  try {
    const bridge = new MobileBridgeService({
      electronDir: context.config.electronDir,
      isDev: context.config.isDev,
      getDevServerUrl: () => getDevServerUrl() ?? "",
    });
    context.state.mobileBridgeService = bridge;
    bridge.start();

    // Wire auth state into the bridge for Convex registration
    const authService = context.services.authService;
    const syncBridgeAuth = async () => {
      bridge.setDeviceId(context.state.deviceId);
      bridge.setHostAuthToken(await authService.getAuthToken());
      bridge.setConvexSiteUrl(authService.getConvexSiteUrl());
    };

    // Sync whenever auth state changes (runner initialization sets deviceId/tokens)
    const interval = setInterval(() => {
      void syncBridgeAuth();
    }, 30_000);
    void syncBridgeAuth();

    // Clean up interval on quit (bridge.stop() is called separately in lifecycle)
    app.on("before-quit", () => clearInterval(interval));
  } catch (error) {
    console.error(
      "[mobile-bridge] Failed to start:",
      (error as Error).message,
    );
  }
};

export const initializeStellaHostRunner = async (context: BootstrapContext) => {
  const { lifecycle, services, state } = context;
  const stellaHomePath = state.stellaHomePath;
  const statePath = stellaHomePath ? path.join(stellaHomePath, "state") : null;
  if (!stellaHomePath || !statePath) {
    throw new Error("Stella home is not initialized.");
  }

  await services.securityPolicyService.loadPolicy();

  const deviceIdentity = await getOrCreateDeviceIdentity(statePath);
  state.deviceId = deviceIdentity.deviceId;

  if (!state.schedulerService) {
    state.schedulerService = new LocalSchedulerService({
      stellaHome: stellaHomePath,
      runnerTarget: lifecycle,
    });
  } else {
    state.schedulerService.stop();
  }

  lifecycle.setRunner(createStellaHostRunner({
    deviceId: state.deviceId,
    stellaHomePath,
    runtimeStore: state.runtimeStore!,
    storeModService: state.storeModService!,
    frontendRoot: context.config.frontendRoot,
    listLocalChatEvents: (conversationId, maxItems) =>
      state.chatStore?.listEvents(conversationId, maxItems) ?? [],
    getHmrMorphOrchestrator: () => state.hmrMorphOrchestrator,
    requestCredential: (payload) =>
      services.credentialService.requestCredential(payload),
    displayHtml: (html) => {
      const targets = state.windowManager
        ? state.windowManager.getAllWindows()
        : BrowserWindow.getAllWindows();

      for (const window of targets) {
        if (!window.isDestroyed()) {
          window.webContents.send("display:update", html);
        }
      }
    },
    scheduleApi: {
      listCronJobs: async () => state.schedulerService!.listCronJobs(),
      addCronJob: async (input) => state.schedulerService!.addCronJob(input),
      updateCronJob: async (jobId, patch) =>
        state.schedulerService!.updateCronJob(jobId, patch),
      removeCronJob: async (jobId) =>
        state.schedulerService!.removeCronJob(jobId),
      runCronJob: async (jobId) => state.schedulerService!.runCronJob(jobId),
      getHeartbeatConfig: async (conversationId) =>
        state.schedulerService!.getHeartbeatConfig(conversationId),
      upsertHeartbeat: async (input) =>
        state.schedulerService!.upsertHeartbeat(input),
      runHeartbeat: async (conversationId) =>
        state.schedulerService!.runHeartbeat(conversationId),
    },
    signHeartbeatPayload: async (signedAtMs: number) => ({
      publicKey: deviceIdentity.publicKey,
      signature: signDeviceHeartbeat(deviceIdentity, signedAtMs),
    }),
  }));

  const pendingConvexUrl = services.authService.getPendingConvexUrl();
  if (pendingConvexUrl) {
    lifecycle.getRunner()!.setConvexUrl(pendingConvexUrl);
    services.socialSessionService.setConvexUrl(pendingConvexUrl);
  }
  const pendingAuthToken = await services.authService.getAuthToken();
  services.socialSessionService.setAuthToken(pendingAuthToken);
  services.socialSessionService.start();

  lifecycle.getRunner()!.start();
  state.schedulerService.start();
};

export const startDeferredStartup = (context: BootstrapContext) => {
  const { config, services, state } = context;

  if (state.deferredStartupSequence) {
    return state.deferredStartupSequence;
  }

  const startupTasks: Array<{
    delayMs?: number;
    label: string;
    run: () => Promise<void> | void;
  }> = [
    {
      label: "overlay-window",
      run: () => {
        state.overlayController?.create();
      },
    },
    {
      label: "selected-text",
      delayMs: config.startupStageDelayMs,
      run: () => {
        initSelectedTextProcess();
        if (process.platform === "win32") {
          setTimeout(() => {
            void getSelectedText();
          }, 250);
        }
      },
    },
    {
      label: "global-input-hooks",
      delayMs: config.startupStageDelayMs,
      run: () => {
        services.radialGestureService.start();
      },
    },
    {
      label: "wake-word",
      delayMs: config.startupStageDelayMs,
      run: async () => {
        try {
          state.wakeWordController?.dispose();
          state.wakeWordController = await initializeWakeWord({
            isDev: config.isDev,
            electronDir: config.electronDir,
            uiStateService: services.uiStateService,
            isAppReady: () => state.appReady,
            onEnabledChange: () => {
              broadcastWakeWordState(context);
            },
          });
          broadcastWakeWordState(context);
        } catch (error) {
          console.error(
            "[WakeWord] Failed to initialize:",
            (error as Error).message,
          );
        }
      },
    },
  ];

  state.deferredStartupSequence = (async () => {
    for (const task of startupTasks) {
      if (task.delayMs) {
        await wait(task.delayMs);
      }
      if (state.isQuitting) {
        return;
      }
      await task.run();
    }
  })().catch((error) => {
    console.error(
      "[startup] Deferred startup failed:",
      (error as Error).message,
    );
  });

  return state.deferredStartupSequence;
};

const initializeBootstrapLocalState = async (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const stellaHome = await resolveStellaHome(app);

  lifecycle.setStellaHomePath(stellaHome.homePath);
  state.stellaHomePath = stellaHome.homePath;
  state.stellaWorkspacePath = stellaHome.workspacePath;
  state.desktopDatabase?.close();
  state.desktopDatabase = createDesktopDatabase(stellaHome.homePath);

  const transcriptMirror = new TranscriptMirror(
    path.join(stellaHome.homePath, "state"),
  );

  state.chatStore = new ChatStore(state.desktopDatabase, transcriptMirror);
  state.runtimeStore = new RuntimeStore(
    state.desktopDatabase,
    transcriptMirror,
  );
  state.storeModStore = new StoreModStore(state.desktopDatabase);
  state.socialSessionStore = new SocialSessionStore(state.desktopDatabase);
  state.storeModService = new StoreModService(
    config.frontendRoot,
    state.storeModStore,
  );

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaHome.statePath, "security_policy.json"),
  );

  emitStartupMetric({
    metric: "bootstrap-local-state-ready",
    source: "electron-main",
  });
};

const bindUiStateTargets = (context: BootstrapContext) => {
  const { services, state } = context;

  services.uiStateService.bind({
    broadcastTarget: {
      getAllWindows: () =>
        state.windowManager
          ? state.windowManager.getAllWindows()
          : BrowserWindow.getAllWindows(),
    },
    getOverlayTarget: () =>
      state.overlayController
        ? {
            showVoice: (x, y, mode) =>
              state.overlayController!.showVoice(x, y, mode),
            hideVoice: () => state.overlayController!.hideVoice(),
          }
        : null,
    getBroadcastToMobile: () => getMobileBroadcast(context),
  });
};

const initializeWindowControllers = (context: BootstrapContext) => {
  const { config, lifecycle, services, state } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");

  state.overlayController = new OverlayWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.isDev,
    getDevServerUrl,
  });

  lifecycle.setWindowManager(new WindowManager({
    electronDir: config.electronDir,
    preloadPath,
    sessionPartition: config.sessionPartition,
    isDev: config.isDev,
    getDevServerUrl,
    isAppReady: () => state.appReady,
    isQuitting: () => state.isQuitting,
    externalLinkService: services.externalLinkService,
    miniBridgeService: services.miniBridgeService,
    chatContextSyncBridge: {
      getChatContextVersion: () =>
        services.captureService.getChatContextVersion(),
      getLastBroadcastChatContextVersion: () =>
        services.captureService.getLastBroadcastChatContextVersion(),
      broadcastChatContext: () =>
        services.captureService.broadcastChatContext(),
      waitForMiniChatContext: (version: number) =>
        services.captureService.waitForMiniChatContext(version),
    },
    onDeactivateVoiceModes: () =>
      services.uiStateService.deactivateVoiceModes(),
    onUpdateUiState: (partial) => services.uiStateService.update(partial),
    getOverlayController: () => state.overlayController,
  }));

  bindUiStateTargets(context);
};

const initializeUiServerAndSelfMod = (context: BootstrapContext) => {
  const { config, state } = context;

  startStellaUiServer({
    getWindow: () => state.windowManager?.getFullWindow() ?? null,
    frontendRoot: config.frontendRoot,
    statePath: path.join(state.stellaHomePath!, "state"),
    getProxy: () => state.stellaHostRunner?.getProxy() ?? null,
  });

  state.hmrMorphOrchestrator = createHmrMorphOrchestrator({
    getFullWindow: () => state.windowManager?.getFullWindow() ?? null,
    getOverlayController: () => state.overlayController,
  });
};

const finalizeWindowLaunch = (context: BootstrapContext) => {
  const { config, services, state } = context;

  state.windowManager!.createInitialWindows();

  const pendingAuthCallback = services.authService.consumePendingAuthCallback();
  const fullWindow = state.windowManager!.getFullWindow();

  if (pendingAuthCallback && fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      broadcastAuthCallback(context, pendingAuthCallback);
    });
  }

  if (fullWindow) {
    fullWindow.webContents.once("did-finish-load", () => {
      void startDeferredStartup(context);
    });
  }

  state.windowManager!.showWindow("full");
  setTimeout(() => {
    void startDeferredStartup(context);
  }, config.startupStageDelayMs);
};

const startDevToolServer = (context: BootstrapContext) => {
  if (!context.config.isDev) return;

  const server = new DevToolServer({
    stellaHomePath: () => context.state.stellaHomePath,
    sessionPartition: context.config.sessionPartition,
    shutdownRuntime: () => shutdownBootstrapRuntime(context, { stopScheduler: true }),
    onReloadApp: () => {
      const fullWindow = context.state.windowManager?.getFullWindow();
      if (fullWindow && !fullWindow.isDestroyed()) {
        fullWindow.webContents.reload();
      }
    },
  });

  context.state.devToolServer = server;
  server.start();
};

export const initializeBootstrapApplication = async (
  context: BootstrapContext,
) => {
  emitStartupMetric({
    metric: "bootstrap-application-initialize-started",
    source: "electron-main",
  });

  const { services } = context;

  services.authService.registerAuthProtocol();
  services.authService.captureInitialAuthUrl(process.argv);

  await initializeBootstrapLocalState(context);
  initializeWindowControllers(context);
  initializeUiServerAndSelfMod(context);
  registerBootstrapIpcHandlers(
    context,
    createBootstrapResetFlows(context, {
      initializeStellaHostRunner: () => initializeStellaHostRunner(context),
    }),
  );

  finalizeWindowLaunch(context);

  void (async () => {
    await initializeStellaHostRunner(context);
    emitStartupMetric({
      metric: "host-runtime-ready",
      source: "electron-main",
    });
    setTimeout(() => {
      if (context.state.isQuitting) {
        return;
      }
      void startMobileBridge(context);
      startDevToolServer(context);
    }, POST_WINDOW_AUX_START_DELAY_MS);
  })().catch((error) => {
    console.error(
      "[startup] Host runtime initialization failed:",
      (error as Error).message,
    );
  });
};
