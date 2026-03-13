import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeWakeWord } from "../../../electron/wake-word/initialize.js";

const mockIpcMainOn = vi.fn();
const mockCreateWakeWordDetector = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    on: (...args: unknown[]) => mockIpcMainOn(...args),
  },
}));

vi.mock("../../../electron/wake-word/detector.js", () => ({
  createWakeWordDetector: (...args: unknown[]) =>
    mockCreateWakeWordDetector(...args),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("initializeWakeWord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports wake-word enabled while startup is in flight", async () => {
    const startDeferred = createDeferred<void>();
    let appReady = false;
    const detector = {
      start: vi.fn(() => startDeferred.promise),
      stop: vi.fn(),
      predict: vi.fn(),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => false),
      dispose: vi.fn(),
    };
    mockCreateWakeWordDetector.mockResolvedValue(detector);

    const uiStateService = {
      state: {
        mode: "chat",
        window: "full",
        view: "home",
        conversationId: null,
        isVoiceActive: false,
        isVoiceRtcActive: false,
      },
      activateVoiceRtc: vi.fn(),
      setResumeWakeWordCapture: vi.fn(),
    };
    const onEnabledChange = vi.fn();

    const controller = await initializeWakeWord({
      isDev: true,
      electronDir: "C:\\Users\\redacted\\projects\\stella\\desktop\\electron",
      uiStateService: uiStateService as never,
      isAppReady: () => appReady,
      onEnabledChange,
    });

    appReady = true;

    expect(controller.syncState()).toBe(true);
    expect(controller.getEnabled()).toBe(true);
    expect(onEnabledChange).toHaveBeenCalledWith(true);

    startDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getEnabled()).toBe(true);
  });

  it("does not republish enabled when a pending start resolves after a later disable", async () => {
    const startDeferred = createDeferred<void>();
    let appReady = false;
    const detector = {
      start: vi.fn(() => startDeferred.promise),
      stop: vi.fn(),
      predict: vi.fn(),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => false),
      dispose: vi.fn(),
    };
    mockCreateWakeWordDetector.mockResolvedValue(detector);

    const uiStateService = {
      state: {
        mode: "chat",
        window: "full",
        view: "home",
        conversationId: null,
        isVoiceActive: false,
        isVoiceRtcActive: false,
      },
      activateVoiceRtc: vi.fn(),
      setResumeWakeWordCapture: vi.fn(),
    };
    const onEnabledChange = vi.fn();

    const controller = await initializeWakeWord({
      isDev: true,
      electronDir: "C:\\Users\\redacted\\projects\\stella\\desktop\\electron",
      uiStateService: uiStateService as never,
      isAppReady: () => appReady,
      onEnabledChange,
    });

    appReady = true;
    expect(controller.syncState()).toBe(true);
    expect(onEnabledChange).toHaveBeenCalledTimes(1);
    expect(onEnabledChange).toHaveBeenLastCalledWith(true);

    uiStateService.state.isVoiceRtcActive = true;
    expect(controller.syncState()).toBe(false);
    expect(onEnabledChange).toHaveBeenCalledTimes(2);
    expect(onEnabledChange).toHaveBeenLastCalledWith(false);

    startDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onEnabledChange).toHaveBeenCalledTimes(2);
    expect(controller.getEnabled()).toBe(false);
  });
});
