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
    let runnerAvailable = false;

    setTimeout(() => {
      runnerAvailable = true;
    }, 25);

    registerLocalChatHandlers({
      getStellaHostRunner: () =>
        runnerAvailable
          ? ({
              waitUntilConnected: vi.fn(async () => {}),
              waitUntilReady: vi.fn(async () => {
                throw new Error("should not require full readiness");
              }),
              client: {
                getOrCreateDefaultConversationId,
              },
            } as never)
          : null,
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("localChat:getOrCreateDefaultConversationId");

    await expect(handler?.({})).resolves.toBe("conv-123");
    expect(getOrCreateDefaultConversationId).toHaveBeenCalledTimes(1);
  });
});
