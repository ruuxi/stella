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

const { createBootstrapResetFlows, shutdownBootstrapRuntime } = await import(
  "../../../electron/bootstrap/resets.js"
);

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

  it("drops host runtime state without discarding the scheduler instance", () => {
    const stopRunner = vi.fn();
    const closeDb = vi.fn();
    const stopScheduler = vi.fn();
    const context = {
      state: {
        chatStore: { id: "chat" },
        desktopDatabase: { close: closeDb },
        runtimeStore: { id: "runtime" },
        schedulerService: { stop: stopScheduler },
        stellaHostRunner: { stop: stopRunner },
        storeModService: { id: "mods" },
        storeModStore: { id: "mod-store" },
      },
    };

    shutdownBootstrapRuntime(context as never, { stopScheduler: true });

    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(context.state.stellaHostRunner).toBeNull();
    expect(context.state.chatStore).toBeNull();
    expect(context.state.runtimeStore).toBeNull();
    expect(context.state.storeModStore).toBeNull();
    expect(context.state.storeModService).toBeNull();
    expect(context.state.desktopDatabase).toBeNull();
    expect(context.state.schedulerService).not.toBeNull();
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
    const stopRunner = vi.fn();
    const closeDb = vi.fn();
    const stopScheduler = vi.fn();
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
        chatStore: { id: "chat" },
        desktopDatabase: { close: closeDb },
        runtimeStore: { id: "runtime" },
        schedulerService: { stop: stopScheduler },
        stellaHomePath: null,
        stellaHostRunner: { stop: stopRunner },
        storeModService: { id: "mods" },
        storeModStore: { id: "mod-store" },
        windowManager: {
          hideMiniWindow,
        },
      },
    };

    const resetFlows = createBootstrapResetFlows(context as never, {
      initializeStellaHostRunner,
    });

    await expect(resetFlows.hardResetLocalState()).resolves.toEqual({
      ok: true,
    });

    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(stopScheduler).toHaveBeenCalledTimes(1);
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
    const closeDb = vi.fn();
    const stopRunner = vi.fn();
    const initializeStellaHostRunner = vi.fn(async () => {});
    const context = {
      state: {
        chatStore: { id: "chat" },
        desktopDatabase: { close: closeDb },
        runtimeStore: { id: "runtime" },
        schedulerService: null,
        stellaHomePath: "/mock/home/.stella",
        stellaHostRunner: { stop: stopRunner },
        storeModService: { id: "mods" },
        storeModStore: { id: "mod-store" },
      },
    };

    const resetFlows = createBootstrapResetFlows(context as never, {
      initializeStellaHostRunner,
    });

    await expect(resetFlows.resetLocalMessages()).resolves.toEqual({
      ok: true,
    });

    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(resetMessageStorageMock).toHaveBeenCalledWith(
      "/mock/home/.stella",
    );
    expect(initializeStellaHostRunner).toHaveBeenCalledTimes(1);
    expect(broadcastLocalChatUpdatedMock).toHaveBeenCalledWith(context);
  });
});
