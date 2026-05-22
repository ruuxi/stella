import { describe, expect, it, vi } from "vitest";
import type { ChatContext } from "../../../runtime/contracts/index.js";

vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}));

vi.mock("uiohook-napi", () => ({
  uIOhook: {
    on: vi.fn(),
    off: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
  UiohookKeyboardEvent: class {},
  UiohookMouseEvent: class {},
}));

const { RadialGestureService } = await import(
  "../../electron/services/radial-gesture-service.js"
);

type HandleSelectionOnly = {
  handleSelection: (wedge: "capture" | "add") => Promise<void> | void;
};

const windowBridge = {
  isCompactMode: vi.fn(() => false),
  getLastActiveWindowMode: vi.fn(() => "full" as const),
  getLastFocusedWindowMode: vi.fn(() => "full" as const),
  isMiniShowing: vi.fn(() => false),
  isMiniAlwaysOnTop: vi.fn(() => false),
  isWindowFocused: vi.fn(() => true),
  isShellWindowVisible: vi.fn(() => true),
  isShellWindowFocused: vi.fn(() => true),
  showWindow: vi.fn(),
  restoreWindowVisibility: vi.fn(),
  minimizeWindow: vi.fn(),
  hideMiniWindow: vi.fn(),
};

const regionCapture = {
  screenshot: {
    dataUrl: "data:image/png;base64,capture",
    width: 100,
    height: 80,
  },
  window: {
    app: "Preview",
    title: "Example",
    bounds: { x: 0, y: 0, width: 100, height: 80 },
  },
};

const createService = () => {
  const capture = {
    cancelRadialContextCapture: vi.fn(),
    getChatContextSnapshot: vi.fn(() => null as ChatContext | null),
    setPendingChatContext: vi.fn(),
    clearTransientContext: vi.fn(),
    setRadialContextShouldCommit: vi.fn(),
    setRadialWindowContextEnabled: vi.fn(),
    commitStagedRadialContext: vi.fn(),
    hasPendingRadialCapture: vi.fn(() => false),
    captureRadialContext: vi.fn(),
    startRegionCapture: vi.fn(async () => regionCapture),
    mergeRegionCaptureResult: vi.fn(),
    emptyContext: vi.fn(() => ({
      window: null,
      browserUrl: null,
      selectedText: null,
      regionScreenshots: [],
    })),
    broadcastChatContext: vi.fn(),
  };
  const overlay = {
    showRadial: vi.fn(),
    hideRadial: vi.fn(),
    updateRadialCursor: vi.fn(),
    getRadialBounds: vi.fn(() => ({ x: 0, y: 0 })),
  };
  const updateUiState = vi.fn();
  const service = new RadialGestureService({
    getRadialTriggerKey: () => "SystemChord",
    getMiniDoubleTapModifier: () => "Off",
    shouldEnable: () => true,
    capture,
    overlay,
    window: windowBridge,
    togglePetVoice: vi.fn(),
    updateUiState,
  });

  return { service: service as unknown as HandleSelectionOnly, capture, overlay };
};

describe("RadialGestureService capture wedge", () => {
  it("does not pre-commit staged hover context before explicit capture", async () => {
    const { service, capture } = createService();

    await service.handleSelection("capture");

    expect(capture.setRadialContextShouldCommit).not.toHaveBeenCalledWith(true);
    expect(capture.commitStagedRadialContext).not.toHaveBeenCalled();
    expect(capture.cancelRadialContextCapture).toHaveBeenCalledOnce();
    expect(capture.startRegionCapture).toHaveBeenCalledOnce();
    expect(capture.mergeRegionCaptureResult).toHaveBeenCalledWith(regionCapture);
  });

  it("still commits staged hover context for the add wedge", () => {
    const { service, capture } = createService();

    service.handleSelection("add");

    expect(capture.setRadialContextShouldCommit).toHaveBeenCalledWith(true);
    expect(capture.commitStagedRadialContext).toHaveBeenCalledOnce();
  });
});
