import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
  },
}));

const { registerScheduleHandlers } = await import(
  "../../../electron/ipc/schedule-handlers.js"
);

describe("registerScheduleHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
  });

  it("waits for the sidecar-backed runner before listing heartbeats", async () => {
    const listHeartbeats = vi.fn(async () => []);
    let runnerAvailable = false;

    setTimeout(() => {
      runnerAvailable = true;
    }, 25);

    registerScheduleHandlers({
      getStellaHostRunner: () =>
        runnerAvailable
          ? ({
              waitUntilConnected: vi.fn(async () => {}),
              waitUntilReady: vi.fn(async () => {
                throw new Error("should not require full readiness");
              }),
              listHeartbeats,
            } as never)
          : null,
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("schedule:listHeartbeats");

    await expect(handler?.({})).resolves.toEqual([]);
    expect(listHeartbeats).toHaveBeenCalledTimes(1);
  });
});
