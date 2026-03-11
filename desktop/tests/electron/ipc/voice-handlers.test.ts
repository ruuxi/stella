import { beforeEach, describe, expect, it, vi } from "vitest";

const registerShortcut = vi.fn();
const unregisterShortcut = vi.fn();
const ipcOnHandlers = new Map<string, (...args: unknown[]) => void>();
const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  globalShortcut: {
    register: registerShortcut,
    unregister: unregisterShortcut,
  },
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcOnHandlers.set(channel, handler);
    }),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler);
    }),
  },
}));

const { registerVoiceHandlers } = await import("../../../electron/ipc/voice-handlers.js");

const createOptions = () => ({
  uiState: {
    isVoiceActive: false,
    isVoiceRtcActive: false,
    mode: "chat",
    window: "full",
  },
  getAppReady: () => true,
  windowManager: {
    getAllWindows: () => [],
    getMiniWindow: () => null,
    getFullWindow: () => null,
  },
  broadcastUiState: vi.fn(),
  scheduleResumeWakeWord: vi.fn(),
  syncVoiceOverlay: vi.fn(),
  syncWakeWordState: vi.fn(() => true),
  getWakeWordEnabled: vi.fn(() => true),
  pushWakeWordAudio: vi.fn(),
  getStellaHostRunner: () => null,
  getOverlayController: () => null,
  getConvexSiteUrl: () => null,
  getAuthToken: () => null,
  setAssistantSpeaking: vi.fn().mockResolvedValue(undefined),
});

describe("registerVoiceHandlers", () => {
  beforeEach(() => {
    registerShortcut.mockReset();
    unregisterShortcut.mockReset();
    ipcOnHandlers.clear();
    ipcHandleHandlers.clear();
    registerShortcut.mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps the current voice shortcut active when a replacement cannot be registered", async () => {
    registerVoiceHandlers(createOptions() as never);

    const setVoiceShortcut = ipcHandleHandlers.get("voice:setShortcut");
    expect(setVoiceShortcut).toBeTypeOf("function");

    registerShortcut.mockReset();
    registerShortcut
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = await setVoiceShortcut?.({}, "Alt+Shift+V");

    expect(unregisterShortcut).toHaveBeenCalledWith("CommandOrControl+Shift+V");
    expect(registerShortcut).toHaveBeenNthCalledWith(
      1,
      "Alt+Shift+V",
      expect.any(Function),
    );
    expect(registerShortcut).toHaveBeenNthCalledWith(
      2,
      "CommandOrControl+Shift+V",
      expect.any(Function),
    );
    expect(result).toEqual({
      ok: false,
      requestedShortcut: "Alt+Shift+V",
      activeShortcut: "CommandOrControl+Shift+V",
      error: expect.stringContaining('Kept "CommandOrControl+Shift+V" active instead.'),
    });
  });

  it("retries the default shortcut after an initial registration failure", async () => {
    registerShortcut
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    registerVoiceHandlers(createOptions() as never);

    const setVoiceShortcut = ipcHandleHandlers.get("voice:setShortcut");
    expect(setVoiceShortcut).toBeTypeOf("function");

    registerShortcut.mockReset();
    unregisterShortcut.mockReset();
    registerShortcut.mockReturnValueOnce(true);

    const result = await setVoiceShortcut?.({}, "CommandOrControl+Shift+V");

    expect(unregisterShortcut).not.toHaveBeenCalled();
    expect(registerShortcut).toHaveBeenCalledOnce();
    expect(registerShortcut).toHaveBeenCalledWith(
      "CommandOrControl+Shift+V",
      expect.any(Function),
    );
    expect(result).toEqual({
      ok: true,
      requestedShortcut: "CommandOrControl+Shift+V",
      activeShortcut: "CommandOrControl+Shift+V",
    });
  });
});
