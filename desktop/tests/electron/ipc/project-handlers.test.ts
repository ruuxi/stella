import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialog = vi.fn();
const fromWebContents = vi.fn(() => null);

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents,
  },
  dialog: {
    showOpenDialog,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
  },
}));

const { registerProjectHandlers } = await import(
  "../../../electron/ipc/project-handlers.js"
);

describe("registerProjectHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
    showOpenDialog.mockReset();
    fromWebContents.mockReset();
    fromWebContents.mockReturnValue(null);
  });

  it("waits for the sidecar-backed runner before listing projects", async () => {
    const listProjects = vi.fn(async () => []);
    const runnerListeners = new Set<(runner: unknown) => void>();
    let currentRunner: unknown = null;

    registerProjectHandlers({
      getStellaHostRunner: () => currentRunner as never,
      onStellaHostRunnerChanged: (listener) => {
        runnerListeners.add(listener);
        return () => {
          runnerListeners.delete(listener);
        };
      },
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("projects:list");
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
      listProjects,
    };
    currentRunner = runner;
    for (const listener of runnerListeners) {
      listener(runner);
    }

    await expect(pending).resolves.toEqual([]);
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it("keeps directory picking in Electron but forwards registration to the runner", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/projects/demo"],
    });
    const registerProjectDirectory = vi.fn(async () => ({
      projects: [{ id: "project-1" }],
      selectedProjectId: "project-1",
    }));

    registerProjectHandlers({
      getStellaHostRunner: () =>
        ({
          getAvailabilitySnapshot: () => ({
            connected: true,
            ready: true,
          }),
          onAvailabilityChange: vi.fn(() => () => {}),
          registerProjectDirectory,
        }) as never,
      assertPrivilegedSender: () => true,
    });

    const handler = ipcHandleHandlers.get("projects:pickDirectory");

    await expect(
      handler?.({ sender: {} }),
    ).resolves.toEqual({
      canceled: false,
      projects: [{ id: "project-1" }],
      selectedProjectId: "project-1",
    });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(registerProjectDirectory).toHaveBeenCalledWith("/projects/demo");
  });
});
