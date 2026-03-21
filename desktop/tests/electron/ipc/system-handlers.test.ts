import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  shell: {},
}));

const { registerSystemHandlers } = await import(
  "../../../electron/ipc/system-handlers.js"
);

describe("registerSystemHandlers", () => {
  beforeEach(() => {
    ipcHandleHandlers.clear();
  });

  it("returns a stopped social session snapshot while the sidecar is still connecting", async () => {
    registerSystemHandlers({
      getDeviceId: () => "device-1",
      authService: {} as never,
      getStellaHostRunner: () =>
        ({
          getAvailabilitySnapshot: vi.fn(() => ({
            connected: false,
            ready: false,
            reason: "Stella runtime client is not connected.",
          })),
          onAvailabilityChange: vi.fn(() => () => {}),
          getSocialSessionStatus: vi.fn(),
        }) as never,
      getStellaHomePath: () => null,
      externalLinkService: {
        assertPrivilegedSender: () => true,
      } as never,
      ensurePrivilegedActionApproval: vi.fn(async () => true),
      hardResetLocalState: vi.fn(async () => ({ ok: true })),
      resetLocalMessages: vi.fn(async () => ({ ok: true })),
      submitCredential: vi.fn(() => ({ ok: true })),
      cancelCredential: vi.fn(() => ({ ok: true })),
    });

    const handler = ipcHandleHandlers.get("socialSessions:getStatus");

    await expect(handler?.({})).resolves.toEqual({
      enabled: false,
      status: "stopped",
      sessionCount: 0,
      sessions: [],
    });
  });
});
