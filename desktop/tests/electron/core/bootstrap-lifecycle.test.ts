import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appHandlers = new Map<string, (...args: unknown[]) => void>();
const whenReadyMock = vi.fn(() => Promise.resolve());
const appQuitMock = vi.fn();
const unregisterAllMock = vi.fn();
const cleanupSelectedTextProcessMock = vi.fn();
const initializeBootstrapApplicationMock = vi.fn(async () => {});
const shutdownBootstrapRuntimeMock = vi.fn();

vi.mock("electron", () => ({
  app: {
    whenReady: whenReadyMock,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, handler);
    }),
    quit: appQuitMock,
  },
  globalShortcut: {
    unregisterAll: unregisterAllMock,
  },
}));

vi.mock("../../../electron/selected-text.js", () => ({
  cleanupSelectedTextProcess: cleanupSelectedTextProcessMock,
}));

vi.mock("../../../electron/bootstrap/runtime.js", () => ({
  initializeBootstrapApplication: initializeBootstrapApplicationMock,
}));

vi.mock("../../../electron/bootstrap/resets.js", () => ({
  shutdownBootstrapRuntime: shutdownBootstrapRuntimeMock,
}));

const { initializeBootstrapSingleInstance, registerBootstrapLifecycle } =
  await import("../../../electron/bootstrap/lifecycle.js");

const originalPlatform = process.platform;

const setPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", {
    value: platform,
  });
};

describe("bootstrap lifecycle", () => {
  beforeEach(() => {
    appHandlers.clear();
    whenReadyMock.mockClear();
    appQuitMock.mockClear();
    unregisterAllMock.mockClear();
    cleanupSelectedTextProcessMock.mockClear();
    initializeBootstrapApplicationMock.mockClear();
    shutdownBootstrapRuntimeMock.mockClear();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("binds the auth open-url handler only after acquiring the single-instance lock", () => {
    const bindOpenUrlHandler = vi.fn();
    const context = {
      services: {
        authService: {
          enforceSingleInstanceLock: vi.fn(() => true),
          bindOpenUrlHandler,
        },
      },
    };

    expect(initializeBootstrapSingleInstance(context as never)).toBe(true);
    expect(bindOpenUrlHandler).toHaveBeenCalledTimes(1);
  });

  it("stops bootstrap work when another instance already owns the lock", () => {
    const bindOpenUrlHandler = vi.fn();
    const context = {
      services: {
        authService: {
          enforceSingleInstanceLock: vi.fn(() => false),
          bindOpenUrlHandler,
        },
      },
    };

    expect(initializeBootstrapSingleInstance(context as never)).toBe(false);
    expect(bindOpenUrlHandler).not.toHaveBeenCalled();
  });

  it("registers lifecycle handlers and tears runtime state down on quit", async () => {
    const stopAll = vi.fn(async () => {});
    const stopAuthRefreshLoop = vi.fn();
    const radialStop = vi.fn();
    const killAllShells = vi.fn();
    const schedulerStop = vi.fn();
    const wakeWordDispose = vi.fn();
    const overlayDestroy = vi.fn();
    const onActivate = vi.fn();

    const context = {
      services: {
        authService: {
          stopAuthRefreshLoop,
        },
        devProjectService: {
          stopAll,
        },
        radialGestureService: {
          stop: radialStop,
        },
      },
      state: {
        isQuitting: false,
        overlayController: {
          destroy: overlayDestroy,
        },
        schedulerService: {
          stop: schedulerStop,
        },
        stellaHostRunner: {
          killAllShells,
        },
        wakeWordController: {
          dispose: wakeWordDispose,
        },
        windowManager: {
          onActivate,
        },
      },
    };

    setPlatform("win32");

    registerBootstrapLifecycle(context as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(whenReadyMock).toHaveBeenCalledTimes(1);
    expect(initializeBootstrapApplicationMock).toHaveBeenCalledWith(context);
    expect(appHandlers.has("activate")).toBe(true);
    expect(appHandlers.has("window-all-closed")).toBe(true);
    expect(appHandlers.has("before-quit")).toBe(true);
    expect(appHandlers.has("will-quit")).toBe(true);

    appHandlers.get("activate")?.();
    expect(onActivate).toHaveBeenCalledTimes(1);

    appHandlers.get("before-quit")?.();
    expect(context.state.isQuitting).toBe(true);
    expect(stopAuthRefreshLoop).toHaveBeenCalledTimes(1);
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(killAllShells).toHaveBeenCalledTimes(1);
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    expect(wakeWordDispose).toHaveBeenCalledTimes(1);
    expect(context.state.wakeWordController).toBeNull();
    expect(cleanupSelectedTextProcessMock).toHaveBeenCalledTimes(1);
    expect(overlayDestroy).toHaveBeenCalledTimes(1);

    appHandlers.get("will-quit")?.();
    expect(unregisterAllMock).toHaveBeenCalledTimes(1);
    expect(radialStop).toHaveBeenCalledTimes(1);
    expect(shutdownBootstrapRuntimeMock).toHaveBeenCalledWith(context, {
      stopScheduler: true,
    });

    appHandlers.get("window-all-closed")?.();
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });
});
