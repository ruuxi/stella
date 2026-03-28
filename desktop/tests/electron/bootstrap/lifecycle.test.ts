import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appHandlers,
  app,
  globalShortcut,
  cleanupSelectedTextProcess,
  scheduleBootstrapRuntimeShutdown,
  initializeBootstrapApplication,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const appMock = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return appMock;
    }),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  };

  return {
    appHandlers: handlers,
    app: appMock,
    globalShortcut: {
      unregisterAll: vi.fn(),
    },
    cleanupSelectedTextProcess: vi.fn(),
    scheduleBootstrapRuntimeShutdown: vi.fn(),
    initializeBootstrapApplication: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app,
  globalShortcut,
}));

vi.mock("../../../electron/selected-text.js", () => ({
  cleanupSelectedTextProcess,
}));

vi.mock("../../../electron/bootstrap/resets.js", () => ({
  scheduleBootstrapRuntimeShutdown,
}));

vi.mock("../../../electron/bootstrap/runtime.js", () => ({
  initializeBootstrapApplication,
}));

import { registerBootstrapLifecycle } from "../../../electron/bootstrap/lifecycle.js";

describe("bootstrap lifecycle", () => {
  beforeEach(() => {
    appHandlers.clear();
    app.on.mockClear();
    app.whenReady.mockClear();
    app.quit.mockClear();
    globalShortcut.unregisterAll.mockClear();
    cleanupSelectedTextProcess.mockClear();
    scheduleBootstrapRuntimeShutdown.mockClear();
    initializeBootstrapApplication.mockClear();
  });

  it("stops the Cloudflare tunnel on app quit", () => {
    const wakeWordController = {
      dispose: vi.fn(),
    };

    const context = {
      services: {
        authService: {
          stopAuthRefreshLoop: vi.fn(),
        },
        radialGestureService: {
          stop: vi.fn(),
        },
      },
      state: {
        isQuitting: false,
        stellaHostRunner: {
          killAllShells: vi.fn(),
        },
        stellaBrowserBridgeService: {
          stop: vi.fn(),
        },
        tunnelService: {
          stop: vi.fn(),
        },
        wakeWordController,
        overlayController: {
          destroy: vi.fn(),
        },
        mobileBridgeService: {
          stop: vi.fn(),
        },
        windowManager: null,
      },
    };

    registerBootstrapLifecycle(context as never);

    const beforeQuit = appHandlers.get("before-quit");
    expect(beforeQuit).toBeTypeOf("function");

    beforeQuit?.();

    expect(context.state.isQuitting).toBe(true);
    expect(context.services.authService.stopAuthRefreshLoop).toHaveBeenCalledOnce();
    expect(context.state.stellaHostRunner.killAllShells).toHaveBeenCalledOnce();
    expect(context.state.stellaBrowserBridgeService.stop).toHaveBeenCalledOnce();
    expect(context.state.tunnelService.stop).toHaveBeenCalledOnce();
    expect(wakeWordController.dispose).toHaveBeenCalledOnce();
    expect(context.state.wakeWordController).toBeNull();
    expect(cleanupSelectedTextProcess).toHaveBeenCalledOnce();
    expect(context.state.overlayController.destroy).toHaveBeenCalledOnce();
    expect(context.state.mobileBridgeService.stop).toHaveBeenCalledOnce();
  });
});
