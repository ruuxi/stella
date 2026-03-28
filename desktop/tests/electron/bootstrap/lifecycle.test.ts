import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appHandlers,
  app,
  globalShortcut,
  shutdownBootstrapRuntime,
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
    shutdownBootstrapRuntime: vi.fn(),
    initializeBootstrapApplication: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app,
  globalShortcut,
}));

vi.mock("../../../electron/bootstrap/resets.js", () => ({
  shutdownBootstrapRuntime,
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
    shutdownBootstrapRuntime.mockClear();
    initializeBootstrapApplication.mockClear();
  });

  it("routes quit events through the shared process runtime", async () => {
    const processRuntime = {
      registerCleanup: vi.fn(),
      runPhase: vi.fn(async () => undefined),
    };
    const context = {
      services: {
        radialGestureService: {
          stop: vi.fn(),
        },
      },
      state: {
        isQuitting: false,
        processRuntime,
        windowManager: null,
      },
    };

    registerBootstrapLifecycle(context as never);

    const beforeQuit = appHandlers.get("before-quit");
    expect(beforeQuit).toBeTypeOf("function");

    await beforeQuit?.();

    expect(context.state.isQuitting).toBe(true);
    expect(processRuntime.runPhase).toHaveBeenCalledWith("before-quit");
    expect(processRuntime.registerCleanup).toHaveBeenCalledWith(
      "will-quit",
      "global-shortcuts",
      expect.any(Function),
    );
    expect(processRuntime.registerCleanup).toHaveBeenCalledWith(
      "will-quit",
      "radial-gesture-service",
      expect.any(Function),
    );
    expect(processRuntime.registerCleanup).toHaveBeenCalledWith(
      "will-quit",
      "bootstrap-runtime",
      expect.any(Function),
    );

    const willQuit = appHandlers.get("will-quit");
    expect(willQuit).toBeTypeOf("function");

    await willQuit?.();

    expect(processRuntime.runPhase).toHaveBeenCalledWith("will-quit");
  });
});
