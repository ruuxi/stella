import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
  },
}));

const { registerLocalChatHandlers } = await import(
  "../../../electron/ipc/local-chat-handlers.js"
);

describe("registerLocalChatHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
  });

  it("waits for the sidecar-backed runner before serving the default conversation id", async () => {
    const getOrCreateDefaultConversationId = vi.fn(async () => "conv-123");
    const runnerListeners = new Set<(runner: unknown) => void>();
    let currentRunner: unknown = null;

    registerLocalChatHandlers({
      getStellaHostRunner: () => currentRunner as never,
      onStellaHostRunnerChanged: (listener) => {
        runnerListeners.add(listener);
        return () => {
          runnerListeners.delete(listener);
        };
      },
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("localChat:getOrCreateDefaultConversationId");
    const pending = handler?.({});

    const runner = {
      getAvailabilitySnapshot: vi.fn(() => ({
        connected: false,
        ready: false,
      })),
      onAvailabilityChange: vi.fn((listener: (snapshot: { connected: boolean; ready: boolean }) => void) => {
        setTimeout(() => {
          listener({ connected: true, ready: true });
        }, 0);
        return () => {};
      }),
      client: {
        getOrCreateDefaultConversationId,
      },
    };
    currentRunner = runner;
    for (const listener of runnerListeners) {
      listener(runner);
    }

    await expect(pending).resolves.toBe("conv-123");
    expect(getOrCreateDefaultConversationId).toHaveBeenCalledTimes(1);
  });
});
