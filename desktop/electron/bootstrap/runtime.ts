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
import { createBootstrapResetFlows } from "./resets.js";
import {
  type BootstrapContext,
  broadcastAuthCallback,
  broadcastWakeWordState,
} from "./context.js";

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const initializeStellaHostRunner = async (context: BootstrapContext) => {
  const { config, services, state } = context;
  const stellaHome = await resolveStellaHome(app);

  state.stellaHomePath = stellaHome.homePath;
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
  state.storeModService = new StoreModService(
    config.frontendRoot,
    state.storeModStore,
  );

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaHome.statePath, "security_policy.json"),
  );
  await services.securityPolicyService.loadPolicy();

  const deviceIdentity = await getOrCreateDeviceIdentity(stellaHome.statePath);
  state.deviceId = deviceIdentity.deviceId;

  if (!state.schedulerService) {
    state.schedulerService = new LocalSchedulerService({
      stellaHome: stellaHome.homePath,
      getRunner: () => state.stellaHostRunner,
    });
  } else {
    state.schedulerService.stop();
  }

  state.stellaHostRunner = createStellaHostRunner({
    deviceId: state.deviceId,
    StellaHome: stellaHome.homePath,
    runtimeStore: state.runtimeStore!,
    storeModService: state.storeModService!,
    frontendRoot: config.frontendRoot,
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
  });

  const pendingConvexUrl = services.authService.getPendingConvexUrl();
  if (pendingConvexUrl) {
    state.stellaHostRunner.setConvexUrl(pendingConvexUrl);
  }

  state.stellaHostRunner.start();
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
  });
};

const initializeWindowControllers = (context: BootstrapContext) => {
  const { config, services, state } = context;
  const preloadPath = path.join(config.electronDir, "preload.js");

  state.overlayController = new OverlayWindowController({
    preloadPath,
    sessionPartition: config.sessionPartition,
    electronDir: config.electronDir,
    isDev: config.isDev,
    getDevServerUrl,
  });

  state.windowManager = new WindowManager({
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
  });

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

export const initializeBootstrapApplication = async (
  context: BootstrapContext,
) => {
  const { services } = context;

  services.authService.registerAuthProtocol();
  services.authService.captureInitialAuthUrl(process.argv);

  await initializeStellaHostRunner(context);
  initializeWindowControllers(context);
  initializeUiServerAndSelfMod(context);
  registerBootstrapIpcHandlers(
    context,
    createBootstrapResetFlows(context, {
      initializeStellaHostRunner: () => initializeStellaHostRunner(context),
    }),
  );
  finalizeWindowLaunch(context);
};
