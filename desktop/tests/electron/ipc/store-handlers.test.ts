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
    let runnerAvailable = false;

    setTimeout(() => {
      runnerAvailable = true;
    }, 25);

    registerStoreHandlers({
      getStellaHomePath: () => "/mock/home/.stella",
      getStellaHostRunner: () =>
        runnerAvailable
          ? ({
              waitUntilConnected: vi.fn(async () => {}),
              waitUntilReady: vi.fn(async () => {
                throw new Error("should not require full readiness");
              }),
              listInstalledMods,
            } as never)
          : null,
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("store:listInstalledMods");

    await expect(handler?.({})).resolves.toEqual([]);
    expect(listInstalledMods).toHaveBeenCalledTimes(1);
  });
});
