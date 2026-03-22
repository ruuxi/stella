import { app, BrowserWindow } from "electron";
import path from "path";
import { getDevServerUrl } from "../dev-url.js";
import { registerBootstrapIpcHandlers } from "./ipc.js";
import { OverlayWindowController } from "../windows/overlay-window.js";
import { createStellaHostRunner } from "../stella-host-runner.js";
import { getSelectedText, initSelectedTextProcess } from "../selected-text.js";
import { resolveStellaHome } from "../../packages/runtime-kernel/home/stella-home.js";
import { initializeWakeWord } from "../wake-word/initialize.js";
import { WindowManager } from "../windows/window-manager.js";
import { createHmrMorphOrchestrator } from "../self-mod/hmr-morph.js";
import {
  createBootstrapResetFlows,
  shutdownBootstrapRuntime,
  scheduleBootstrapRuntimeShutdown,
} from "./resets.js";
import { MobileBridgeService } from "../services/mobile-bridge/service.js";
import {
  getOrCreateDeviceIdentity,
  signDeviceHeartbeat,
} from "../../packages/runtime-kernel/home/device.js";
import {
  type BootstrapContext,
  broadcastAuthCallback,
  broadcastDevProjectsChanged,
  broadcastLocalChatUpdated,
  broadcastScheduleUpdated,
  broadcastWakeWordState,
  getMobileBroadcast,
} from "./context.js";
import { DevToolServer } from "../devtool/dev-server.js";
import type { SelfModHmrState } from "../../src/shared/contracts/boundary.js";

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const BACKGROUND_RUNTIME_RETRY_DELAY_MS = 2_000;
const POST_WINDOW_AUX_START_DELAY_MS = 1_500;
const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
};

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
  if (!stellaHomePath || !state.stellaWorkspacePath) {
    throw new Error("Stella home is not initialized.");
  }

  await services.securityPolicyService.loadPolicy();

  const loadDeviceIdentity = async () =>
    await getOrCreateDeviceIdentity(path.join(stellaHomePath, "state"));

  state.localChatUpdateUnsubscribe?.();
  state.localChatUpdateUnsubscribe = null;
  state.scheduleUpdateUnsubscribe?.();
  state.scheduleUpdateUnsubscribe = null;
  state.devProjectsUpdateUnsubscribe?.();
  state.devProjectsUpdateUnsubscribe = null;
  await lifecycle.getRunner()?.stop();
  lifecycle.setRunner(
    createStellaHostRunner({
      initializeParams: {
        clientName: "stella-electron-host",
        clientVersion: "0.0.0",
        isDev: context.config.isDev,
        platform: process.platform,
        frontendRoot: context.config.frontendRoot,
        stellaHomePath,
        stellaWorkspacePath: state.stellaWorkspacePath,
      },
      hostHandlers: {
        uiSnapshot: async () => {
          const win = state.windowManager?.getFullWindow() ?? null;
          if (!win || win.isDestroyed()) {
            throw new Error("Window not available");
          }
          return String(
            await win.webContents.executeJavaScript(
              `window.__stellaUI?.snapshot?.() ?? "stella-ui handler not loaded"`,
            ),
          );
        },
        uiAct: async (params) => {
          const win = state.windowManager?.getFullWindow() ?? null;
          if (!win || win.isDestroyed()) {
            throw new Error("Window not available");
          }
          const js =
            params.action === "click"
              ? `window.__stellaUI?.handleCommand("click", [${JSON.stringify(params.ref)}])`
              : params.action === "fill"
                ? `window.__stellaUI?.handleCommand("fill", [${JSON.stringify(params.ref)}, ${JSON.stringify(params.value)}])`
                : `window.__stellaUI?.handleCommand("select", [${JSON.stringify(params.ref)}, ${JSON.stringify(params.value)}])`;
          return String(
            await win.webContents.executeJavaScript(
              `${js} ?? "stella-ui handler not loaded"`,
            ),
          );
        },
        getDeviceIdentity: async () => {
          const identity = await loadDeviceIdentity();
          return {
            deviceId: identity.deviceId,
            publicKey: identity.publicKey,
          };
        },
        signHeartbeatPayload: async (signedAtMs) => {
          const identity = await loadDeviceIdentity();
          return {
            publicKey: identity.publicKey,
            signature: signDeviceHeartbeat(identity, signedAtMs),
          };
        },
        requestCredential: (payload) =>
          services.credentialService.requestCredential(payload),
        displayUpdate: (html) => {
          const targets = state.windowManager
            ? state.windowManager.getAllWindows()
            : BrowserWindow.getAllWindows();
          for (const window of targets) {
            if (!window.isDestroyed()) {
              window.webContents.send("display:update", html);
            }
          }
        },
        openExternal: async (url) => {
          services.externalLinkService.openSafeExternalUrl(url);
        },
        showWindow: async (target) => {
          state.windowManager?.showWindow(target);
        },
        focusWindow: async (target) => {
          const win =
            target === "mini"
              ? state.windowManager?.getMiniWindow()
              : state.windowManager?.getFullWindow();
          win?.focus();
        },
        runHmrTransition: async ({
          requiresFullReload,
          resumeHmr,
          reportState,
        }) => {
          if (state.hmrMorphOrchestrator) {
            await state.hmrMorphOrchestrator.runTransition({
              resumeHmr,
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
          await resumeHmr();
          reportState?.(IDLE_HMR_STATE);
        },
      },
    }),
  );

  const pendingConvexUrl = services.authService.getPendingConvexUrl();
  if (pendingConvexUrl) {
    lifecycle.getRunner()!.setConvexUrl(pendingConvexUrl);
  }
  lifecycle.getRunner()!.setConvexSiteUrl(services.authService.getConvexSiteUrl());
  const pendingAuthToken = await services.authService.getAuthToken();
  lifecycle.getRunner()!.setAuthToken(pendingAuthToken);
  state.localChatUpdateUnsubscribe = lifecycle
    .getRunner()!
    .onLocalChatUpdated(() => {
      broadcastLocalChatUpdated(context);
    });
  state.scheduleUpdateUnsubscribe = lifecycle
    .getRunner()!
    .onScheduleUpdated(() => {
      broadcastScheduleUpdated(context);
    });
  state.devProjectsUpdateUnsubscribe = lifecycle
    .getRunner()!
    .onProjectsUpdated((projects) => {
      broadcastDevProjectsChanged(context, projects);
    });
  await lifecycle.getRunner()!.start();
  const health = await lifecycle.getRunner()!.client.health();
  state.deviceId = health.deviceId;
  try {
    broadcastDevProjectsChanged(
      context,
      await lifecycle.getRunner()!.listProjects(),
    );
  } catch (error) {
    console.debug("[dev-projects] Failed to load initial runtime projects:", error);
  }
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

  services.securityPolicyService.setSecurityPolicyPath(
    path.join(stellaHome.statePath, "security_policy.json"),
  );
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
  const { state } = context;

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
    shutdownRuntime: async () =>
      await shutdownBootstrapRuntime(context, { stopScheduler: true }),
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
  const startHostRunnerInBackground = async (): Promise<void> => {
    if (context.state.isQuitting) {
      return;
    }

    try {
      await initializeStellaHostRunner(context);
      setTimeout(() => {
        if (context.state.isQuitting) {
          return;
        }
        void startMobileBridge(context);
        startDevToolServer(context);
      }, POST_WINDOW_AUX_START_DELAY_MS);
    } catch (error) {
      console.error(
        "[startup] Failed to initialize Stella host runner:",
        (error as Error).message,
      );
      if (!context.state.isQuitting) {
        setTimeout(() => {
          void startHostRunnerInBackground();
        }, BACKGROUND_RUNTIME_RETRY_DELAY_MS);
      }
    }
  };

  void startHostRunnerInBackground();
};
