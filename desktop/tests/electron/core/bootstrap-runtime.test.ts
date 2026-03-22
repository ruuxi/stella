import { beforeEach, describe, expect, it, vi } from "vitest";

const createStellaHostRunnerMock = vi.fn();
const registerBootstrapIpcHandlersMock = vi.fn();
const createBootstrapResetFlowsMock = vi.fn(() => ({}));
const resolveStellaHomeMock = vi.fn(async () => ({
  desktopRoot: "/mock/frontend",
  installRoot: "/mock",
  homePath: "/mock/home/.stella",
  agentsPath: "/mock/home/.stella/agents",
  coreSkillsPath: "/mock/home/.stella/core-skills",
  skillsPath: "/mock/home/.stella/skills",
  extensionsPath: "/mock/home/.stella/extensions",
  statePath: "/mock/home/.stella/state",
  logsPath: "/mock/home/.stella/logs",
  canvasPath: "/mock/home/.stella/canvas",
  workspacePath: "/mock/home/.stella/workspace",
  workspaceAppsPath: "/mock/home/.stella/workspace/apps",
}));
const startAuthRefreshLoopMock = vi.fn();
const windowManagerInstance = {
  createInitialWindows: vi.fn(),
  getFullWindow: vi.fn(() => ({
    webContents: {
      once: vi.fn(),
    },
  })),
  showWindow: vi.fn(),
  getAllWindows: vi.fn(() => []),
};
const WindowManagerMock = vi.fn(function MockWindowManager() {
  return windowManagerInstance;
});
const overlayControllerInstance = {
  create: vi.fn(),
};
const OverlayWindowControllerMock = vi.fn(function MockOverlayWindowController() {
  return overlayControllerInstance;
});
const createHmrMorphOrchestratorMock = vi.fn(() => ({
  runTransition: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/mock/app",
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock("../../../electron/stella-host-runner.js", () => ({
  createStellaHostRunner: createStellaHostRunnerMock,
}));

vi.mock("../../../electron/bootstrap/ipc.js", () => ({
  registerBootstrapIpcHandlers: registerBootstrapIpcHandlersMock,
}));

vi.mock("../../../electron/bootstrap/resets.js", () => ({
  createBootstrapResetFlows: createBootstrapResetFlowsMock,
  scheduleBootstrapRuntimeShutdown: vi.fn(),
}));

vi.mock("../../../packages/runtime-kernel/home/stella-home.js", () => ({
  resolveStellaHome: resolveStellaHomeMock,
}));

vi.mock("../../../electron/windows/window-manager.js", () => ({
  WindowManager: WindowManagerMock,
}));

vi.mock("../../../electron/windows/overlay-window.js", () => ({
  OverlayWindowController: OverlayWindowControllerMock,
}));

vi.mock("../../../electron/self-mod/hmr-morph.js", () => ({
  createHmrMorphOrchestrator: createHmrMorphOrchestratorMock,
}));

vi.mock("../../../electron/selected-text.js", () => ({
  getSelectedText: vi.fn(),
  initSelectedTextProcess: vi.fn(),
}));

vi.mock("../../../electron/wake-word/initialize.js", () => ({
  initializeWakeWord: vi.fn(async () => ({
    dispose: vi.fn(),
    getEnabled: vi.fn(() => false),
  })),
}));

vi.mock("../../../electron/devtool/dev-server.js", () => ({
  startDevToolServer: vi.fn(),
}));

const { initializeStellaHostRunner, initializeBootstrapApplication } = await import(
  "../../../electron/bootstrap/runtime.js"
);

describe("initializeStellaHostRunner", () => {
  beforeEach(() => {
    createStellaHostRunnerMock.mockReset();
    registerBootstrapIpcHandlersMock.mockReset();
    createBootstrapResetFlowsMock.mockClear();
    resolveStellaHomeMock.mockClear();
    startAuthRefreshLoopMock.mockClear();
    windowManagerInstance.createInitialWindows.mockClear();
    windowManagerInstance.getFullWindow.mockClear();
    windowManagerInstance.showWindow.mockClear();
    windowManagerInstance.getAllWindows.mockClear();
    overlayControllerInstance.create.mockClear();
    WindowManagerMock.mockClear();
    OverlayWindowControllerMock.mockClear();
    createHmrMorphOrchestratorMock.mockClear();
  });

  it("registers the host HMR transition callback for sidecar self-mod runs", async () => {
    const runTransition = vi.fn(async () => {});
    const resumeHmr = vi.fn(async () => {});
    const reportState = vi.fn();
    const stop = vi.fn(async () => {});
    const setConvexUrl = vi.fn();
    const setConvexSiteUrl = vi.fn();
    const setAuthToken = vi.fn();
    const onLocalChatUpdated = vi.fn(() => () => {});
    const onScheduleUpdated = vi.fn(() => () => {});
    const onProjectsUpdated = vi.fn(() => () => {});
    const start = vi.fn(async () => {});
    const health = vi.fn(async () => ({ deviceId: "device-1" }));

    createStellaHostRunnerMock.mockReturnValue({
      stop,
      setConvexUrl,
      setConvexSiteUrl,
      setAuthToken,
      onLocalChatUpdated,
      onScheduleUpdated,
      onProjectsUpdated,
      listProjects: vi.fn(async () => []),
      start,
      client: { health },
    });

    const context = {
      config: {
        isDev: true,
        frontendRoot: "/mock/frontend",
      },
      lifecycle: {
        getRunner: vi.fn(() => null),
        setRunner: vi.fn(),
      },
      services: {
        securityPolicyService: {
          loadPolicy: vi.fn(async () => {}),
        },
        authService: {
          getPendingConvexUrl: vi.fn(() => null),
          getConvexSiteUrl: vi.fn(() => null),
          getAuthToken: vi.fn(async () => null),
        },
        credentialService: {
          requestCredential: vi.fn(),
        },
        externalLinkService: {
          openSafeExternalUrl: vi.fn(),
        },
      },
      state: {
        devProjectsUpdateUnsubscribe: null,
        scheduleUpdateUnsubscribe: null,
        stellaHomePath: "/mock/home/.stella",
        stellaWorkspacePath: "/mock/home/.stella/workspace",
        windowManager: null,
        hmrMorphOrchestrator: {
          runTransition,
        },
      },
    };

    let activeRunner = createStellaHostRunnerMock.mock.results[0]?.value ?? null;
    context.lifecycle.getRunner = vi.fn(() => activeRunner);
    context.lifecycle.setRunner = vi.fn((runner) => {
      activeRunner = runner;
    });

    await initializeStellaHostRunner(context as never);

    const firstCall = createStellaHostRunnerMock.mock.calls[0]?.[0];
    expect(firstCall?.hostHandlers.runHmrTransition).toBeTypeOf("function");

    await firstCall.hostHandlers.runHmrTransition({
      requiresFullReload: false,
      resumeHmr,
      reportState,
    });

    expect(runTransition).toHaveBeenCalledWith({
      requiresFullReload: false,
      resumeHmr,
      reportState,
    });
    expect(resumeHmr).not.toHaveBeenCalled();
  });

  it("shows the main window immediately while the sidecar-backed host runner starts in the background", async () => {
    let resolveStart: (() => void) | null = null;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    createStellaHostRunnerMock.mockReturnValue({
      stop: vi.fn(async () => {}),
      setConvexUrl: vi.fn(),
      setConvexSiteUrl: vi.fn(),
      setAuthToken: vi.fn(),
      onLocalChatUpdated: vi.fn(() => () => {}),
      onScheduleUpdated: vi.fn(() => () => {}),
      onProjectsUpdated: vi.fn(() => () => {}),
      listProjects: vi.fn(async () => []),
      start,
      client: {
        health: vi.fn(async () => ({ deviceId: "device-1" })),
      },
    });

    const context = {
      config: {
        authProtocol: "stella",
        electronDir: "/mock/electron",
        frontendRoot: "/mock/frontend",
        hardResetMutableHomePaths: [],
        isDev: false,
        sessionPartition: "persist:stella",
        startupStageDelayMs: 10,
      },
      lifecycle: {
        getRunner: vi.fn(() => null),
        setRunner: vi.fn(),
        setStellaHomePath: vi.fn(),
        setWindowManager: vi.fn((manager) => {
          context.state.windowManager = manager;
        }),
      },
      services: {
        authService: {
          registerAuthProtocol: vi.fn(),
          captureInitialAuthUrl: vi.fn(),
          getPendingConvexUrl: vi.fn(() => null),
          getConvexSiteUrl: vi.fn(() => null),
          getAuthToken: vi.fn(async () => null),
          consumePendingAuthCallback: vi.fn(() => null),
          startAuthRefreshLoop: startAuthRefreshLoopMock,
        },
        securityPolicyService: {
          loadPolicy: vi.fn(async () => {}),
          setSecurityPolicyPath: vi.fn(),
        },
        uiStateService: {
          bind: vi.fn(),
        },
        credentialService: {
          requestCredential: vi.fn(),
        },
        externalLinkService: {
          openSafeExternalUrl: vi.fn(),
          assertPrivilegedSender: vi.fn(() => true),
        },
        miniBridgeService: {},
        captureService: {
          getChatContextVersion: vi.fn(() => 0),
          getLastBroadcastChatContextVersion: vi.fn(() => 0),
        },
        radialGestureService: {
          start: vi.fn(),
          setWindowManager: vi.fn(),
        },
      },
      state: {
        appReady: false,
        appSessionStartedAt: 0,
        deferredStartupSequence: null,
        deviceId: null,
        devProjectsUpdateUnsubscribe: null,
        hmrMorphOrchestrator: null,
        isQuitting: false,
        localChatUpdateUnsubscribe: null,
        overlayController: null,
        scheduleUpdateUnsubscribe: null,
        stellaHomePath: null,
        stellaWorkspacePath: null,
        stellaHostRunner: null,
        wakeWordController: null,
        mobileBridgeService: null,
        devToolServer: null,
        windowManager: null,
      },
    };

    let activeRunner = createStellaHostRunnerMock.mock.results[0]?.value ?? null;
    context.lifecycle.getRunner = vi.fn(() => activeRunner);
    context.lifecycle.setRunner = vi.fn((runner) => {
      activeRunner = runner;
      context.state.stellaHostRunner = runner;
    });

    const initPromise = initializeBootstrapApplication(context as never);
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    await initPromise;

    expect(windowManagerInstance.createInitialWindows).toHaveBeenCalledTimes(1);
    expect(windowManagerInstance.showWindow).toHaveBeenCalledWith("full");

    resolveStart?.();
  });
});

