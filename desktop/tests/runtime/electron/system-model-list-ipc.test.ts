import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    on: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "0.0.0-test"),
    quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  contentTracing: {},
  dialog: {},
  globalShortcut: {
    isRegistered: vi.fn(() => false),
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
  ipcMain: { handle: electronMocks.handle, on: electronMocks.on },
  powerSaveBlocker: {},
  shell: { openExternal: vi.fn() },
}));

import { registerSystemHandlers } from "../../../electron/ipc/system-handlers.js";
import { IPC_PREFERENCES_LIST_MODELS } from "../../../src/shared/contracts/ipc-channels.js";

describe("model-list Electron IPC", () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.handle.mockClear();
    electronMocks.on.mockClear();
  });

  it("rejects an authorized model-list request while the runtime runner is absent", async () => {
    registerSystemHandlers({
      externalLinkService: {
        assertPrivilegedSender: vi.fn(() => true),
      },
      getStellaHostRunner: vi.fn(() => null),
    } as never);

    const handler = electronMocks.handlers.get(IPC_PREFERENCES_LIST_MODELS);
    expect(handler).toBeTypeOf("function");

    await expect(handler?.({})).rejects.toThrow(
      "Stella runtime model catalog is not ready.",
    );
  });
});
