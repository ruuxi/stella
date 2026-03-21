import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
  },
}));

const { registerStoreHandlers } = await import(
  "../../../electron/ipc/store-handlers.js"
);

describe("registerStoreHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
  });

  it("waits for a connected sidecar before listing installed local mods", async () => {
    const listInstalledMods = vi.fn(async () => []);
    const runnerListeners = new Set<(runner: unknown) => void>();
    let currentRunner: unknown = null;

    registerStoreHandlers({
      getStellaHomePath: () => "/mock/home/.stella",
      getStellaHostRunner: () => currentRunner as never,
      onStellaHostRunnerChanged: (listener) => {
        runnerListeners.add(listener);
        return () => {
          runnerListeners.delete(listener);
        };
      },
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("store:listInstalledMods");
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
      listInstalledMods,
    };
    currentRunner = runner;
    for (const listener of runnerListeners) {
      listener(runner);
    }

    await expect(pending).resolves.toEqual([]);
    expect(listInstalledMods).toHaveBeenCalledTimes(1);
  });
});
