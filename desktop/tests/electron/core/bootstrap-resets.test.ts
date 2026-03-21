import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rmMock = vi.fn(async () => {});
const clearStorageDataMock = vi.fn(async () => {});
const clearCacheMock = vi.fn(async () => {});
const fromPartitionMock = vi.fn(() => ({
  clearStorageData: clearStorageDataMock,
  clearCache: clearCacheMock,
}));
const resetMessageStorageMock = vi.fn(async () => {});
const resolveRuntimeHomePathMock = vi.fn(() => "/mock/home/.stella");
const broadcastLocalChatUpdatedMock = vi.fn();

vi.mock("fs", () => ({
  promises: {
    rm: rmMock,
  },
}));

vi.mock("electron", () => ({
  app: { name: "stella-test-app" },
  session: {
    fromPartition: fromPartitionMock,
  },
}));

vi.mock("../../../electron/storage/reset-message-storage.js", () => ({
  resetMessageStorage: resetMessageStorageMock,
}));

vi.mock("../../../electron/system/stella-home.js", () => ({
  resolveRuntimeHomePath: resolveRuntimeHomePathMock,
}));

vi.mock("../../../electron/bootstrap/context.js", () => ({
  broadcastLocalChatUpdated: broadcastLocalChatUpdatedMock,
}));

const { createBootstrapResetFlows, scheduleBootstrapRuntimeShutdown } =
  await import("../../../electron/bootstrap/resets.js");

describe("bootstrap reset flows", () => {
  beforeEach(() => {
    rmMock.mockClear();
    clearStorageDataMock.mockClear();
    clearCacheMock.mockClear();
    fromPartitionMock.mockClear();
    resetMessageStorageMock.mockClear();
    resolveRuntimeHomePathMock.mockClear();
    broadcastLocalChatUpdatedMock.mockClear();
  });

  it("logs scheduled shutdown failures instead of silently swallowing them", async () => {
    const stopError = new Error("stop failed");
    const stopRunner = vi.fn(async () => {
      throw stopError;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const context = {
      state: {
        stellaHostRunner: { stop: stopRunner },
      },
    };

    scheduleBootstrapRuntimeShutdown(context as never, { stopScheduler: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to shut down Stella runtime during scheduled shutdown.",
      stopError,
    );

    errorSpy.mockRestore();
  });

  it("schedules host runtime shutdown without waiting for stop completion", async () => {
    const stopRunner = vi.fn();
    const context = {
      state: {
        stellaHostRunner: { stop: stopRunner },
      },
    };

    scheduleBootstrapRuntimeShutdown(context as never, { stopScheduler: true });

    await Promise.resolve();

    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(context.state.stellaHostRunner).toBeNull();
  });

  it("hard-resets mutable home state and reinitializes the host when one was running", async () => {
    const cancelAll = vi.fn();
    const setHostAuthState = vi.fn();
    const clearPendingAuthCallback = vi.fn();
    const syncVoiceOverlay = vi.fn();
    const broadcast = vi.fn();
    const resetForHardReset = vi.fn();
    const clearAll = vi.fn();
    const clearSenderRateLimits = vi.fn();
    const hideMiniWindow = vi.fn();
    const stopRelease = { current: null as (() => void) | null };
    const stopRunner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          stopRelease.current = () => {
            resolve();
          };
        }),
    );
    const initializeStellaHostRunner = vi.fn(async () => {});

    const context = {
      config: {
        hardResetMutableHomePaths: ["state", "logs"],
        sessionPartition: "persist:Stella",
      },
      services: {
        authService: {
          clearPendingAuthCallback,
          setHostAuthState,
        },
        captureService: {
          resetForHardReset,
        },
        credentialService: {
          cancelAll,
        },
        externalLinkService: {
          clearSenderRateLimits,
        },
        securityPolicyService: {
          clearAll,
        },
        uiStateService: {
          broadcast,
          state: {
            isVoiceActive: true,
            isVoiceRtcActive: true,
          },
          syncVoiceOverlay,
        },
      },
      state: {
        appReady: true,
        stellaHomePath: null,
        stellaHostRunner: { stop: stopRunner },
        windowManager: {
          hideMiniWindow,
        },
      },
    };

    const resetFlows = createBootstrapResetFlows(context as never, {
      initializeStellaHostRunner,
    });

    const resetPromise = resetFlows.hardResetLocalState();
    await Promise.resolve();

    expect(initializeStellaHostRunner).not.toHaveBeenCalled();

    stopRelease.current?.();

    await expect(resetPromise).resolves.toEqual({
      ok: true,
    });

    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(setHostAuthState).toHaveBeenCalledWith(false);
    expect(clearPendingAuthCallback).toHaveBeenCalledTimes(1);
    expect(context.state.appReady).toBe(false);
    expect(context.services.uiStateService.state.isVoiceActive).toBe(false);
    expect(context.services.uiStateService.state.isVoiceRtcActive).toBe(false);
    expect(syncVoiceOverlay).toHaveBeenCalledTimes(1);
    expect(resetForHardReset).toHaveBeenCalledTimes(1);
    expect(hideMiniWindow).toHaveBeenCalledWith(false);
    expect(clearAll).toHaveBeenCalledTimes(1);
    expect(clearSenderRateLimits).toHaveBeenCalledTimes(1);
    expect(fromPartitionMock).toHaveBeenCalledWith("persist:Stella");
    expect(clearStorageDataMock).toHaveBeenCalledTimes(1);
    expect(clearCacheMock).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeHomePathMock).toHaveBeenCalledTimes(1);
    expect(rmMock.mock.calls).toEqual(
      expect.arrayContaining([
        [
          path.join("/mock/home/.stella", "state"),
          { force: true, recursive: true },
        ],
        [
          path.join("/mock/home/.stella", "logs"),
          { force: true, recursive: true },
        ],
      ]),
    );
    expect(initializeStellaHostRunner).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("resets message storage and broadcasts chat updates when local state exists", async () => {
    const stopRelease = { current: null as (() => void) | null };
    const stopRunner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          stopRelease.current = () => {
            resolve();
          };
        }),
    );
    const initializeStellaHostRunner = vi.fn(async () => {});
    const context = {
      state: {
        stellaHomePath: "/mock/home/.stella",
        stellaHostRunner: { stop: stopRunner },
      },
    };

    const resetFlows = createBootstrapResetFlows(context as never, {
      initializeStellaHostRunner,
    });

    const resetPromise = resetFlows.resetLocalMessages();
    await Promise.resolve();

    expect(resetMessageStorageMock).not.toHaveBeenCalled();
    expect(initializeStellaHostRunner).not.toHaveBeenCalled();

    stopRelease.current?.();

    await expect(resetPromise).resolves.toEqual({
      ok: true,
    });

    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(resetMessageStorageMock).toHaveBeenCalledWith(
      "/mock/home/.stella",
    );
    expect(initializeStellaHostRunner).toHaveBeenCalledTimes(1);
    expect(broadcastLocalChatUpdatedMock).toHaveBeenCalledWith(context);
  });
});
