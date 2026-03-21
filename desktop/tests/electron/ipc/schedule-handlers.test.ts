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
    const runnerListeners = new Set<(runner: unknown) => void>();
    let currentRunner: unknown = null;

    registerScheduleHandlers({
      getStellaHostRunner: () => currentRunner as never,
      onStellaHostRunnerChanged: (listener) => {
        runnerListeners.add(listener);
        return () => {
          runnerListeners.delete(listener);
        };
      },
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("schedule:listHeartbeats");
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
      listHeartbeats,
    };
    currentRunner = runner;
    for (const listener of runnerListeners) {
      listener(runner);
    }

    await expect(pending).resolves.toEqual([]);
    expect(listHeartbeats).toHaveBeenCalledTimes(1);
  });
});
