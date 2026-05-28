import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectedTextResult } from "../../electron/selected-text.js";

vi.mock("electron", () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
}));

vi.mock("../../electron/selected-text.js", () => ({
  getSelectedText: vi.fn(),
}));

const { SelectionWatcherService } = await import(
  "../../electron/services/selection-watcher-service.js"
);
const { getSelectedText } = await import("../../electron/selected-text.js");

const getSelectedTextMock = vi.mocked(getSelectedText);

const selectedText = (text: string): SelectedTextResult => ({
  text,
  rect: { x: 80, y: 100, width: 140, height: 20 },
});

const flushSelectionCapture = async () => {
  await vi.advanceTimersByTimeAsync(90);
};

const createService = () => {
  const overlay = {
    showSelectionChip: vi.fn(),
    hideSelectionChip: vi.fn(),
  };
  const window = {
    isStellaFocused: vi.fn(() => false),
    isMiniWindowVisible: vi.fn(() => true),
    routeSelectionToSidebar: vi.fn(),
  };
  const capture = {
    setPendingChatContext: vi.fn(),
    getChatContextSnapshot: vi.fn(),
    broadcastChatContext: vi.fn(),
    emptyContext: vi.fn(),
  };

  const service = new SelectionWatcherService({
    shouldEnable: () => true,
    overlay,
    window,
    capture,
  });
  service.start();

  return { service, overlay, window };
};

describe("SelectionWatcherService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00Z"));
    getSelectedTextMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hides a stale chip when a plain click still reports the previous selection", async () => {
    const { service, overlay } = createService();
    getSelectedTextMock.mockResolvedValueOnce(selectedText("selected text"));

    service.handleLeftMouseUp({ x: 150, y: 120, dragDistance: 40 });
    await flushSelectionCapture();

    expect(overlay.showSelectionChip).toHaveBeenCalledOnce();
    expect(overlay.hideSelectionChip).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(130);
    getSelectedTextMock.mockResolvedValueOnce(selectedText("selected text"));

    service.handleLeftMouseUp({ x: 300, y: 220, dragDistance: 0 });
    await flushSelectionCapture();

    expect(overlay.showSelectionChip).toHaveBeenCalledOnce();
    expect(overlay.hideSelectionChip).toHaveBeenCalledWith(1);
  });

  it("keeps the existing chip when a drag recheck reports the same selection", async () => {
    const { service, overlay } = createService();
    getSelectedTextMock.mockResolvedValueOnce(selectedText("selected text"));

    service.handleLeftMouseUp({ x: 150, y: 120, dragDistance: 40 });
    await flushSelectionCapture();

    await vi.advanceTimersByTimeAsync(130);
    getSelectedTextMock.mockResolvedValueOnce(selectedText("selected text"));

    service.handleLeftMouseUp({ x: 155, y: 122, dragDistance: 42 });
    await flushSelectionCapture();

    expect(overlay.showSelectionChip).toHaveBeenCalledOnce();
    expect(overlay.hideSelectionChip).not.toHaveBeenCalled();
  });
});
