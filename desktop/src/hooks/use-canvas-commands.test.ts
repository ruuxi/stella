import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "./use-conversation-events";
import { useCanvasCommands } from "./use-canvas-commands";

const mockUseCanvas = vi.fn();
const mockSetView = vi.fn();

vi.mock("@/providers/workspace-state", () => ({
  useWorkspace: () => mockUseCanvas(),
}));

vi.mock("@/providers/ui-state", () => ({
  useUiState: () => ({ setView: mockSetView }),
}));

const createEvent = (
  { _id, ...overrides }: Partial<EventRecord> & { type: string; _id: string },
): EventRecord => ({
  _id,
  timestamp: Date.now(),
  ...overrides,
});

describe("useCanvasCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electronAPI = {
      system: { shellKillByPort: vi.fn().mockResolvedValue(undefined) },
    } as unknown as typeof window.electronAPI;
  });

  it("opens canvas on open command and ignores duplicate event IDs", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: null },
      openCanvas,
      closeCanvas,
    });

    const events: EventRecord[] = [
      createEvent({
        _id: "cmd-1",
        type: "canvas_command",
        payload: { action: "open", name: "demo", title: "Demo", url: "http://localhost:3000" },
      }),
    ];

    const { rerender } = renderHook(({ list }) => useCanvasCommands(list), {
      initialProps: { list: events },
    });

    expect(openCanvas).toHaveBeenCalledWith({
      name: "demo",
      title: "Demo",
      url: "http://localhost:3000",
    });

    // Same event id should not be processed again.
    rerender({ list: events });
    expect(openCanvas).toHaveBeenCalledTimes(1);
  });

  it("resets processed IDs when events are cleared", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: null },
      openCanvas,
      closeCanvas,
    });

    const event = createEvent({
      _id: "cmd-reset",
      type: "canvas_command",
      payload: { action: "open", name: "demo" },
    });

    const { rerender } = renderHook(({ list }) => useCanvasCommands(list), {
      initialProps: { list: [event] },
    });
    expect(openCanvas).toHaveBeenCalledTimes(1);

    rerender({ list: [] });
    rerender({ list: [event] });
    expect(openCanvas).toHaveBeenCalledTimes(2);
  });

  it("ignores prepended history while still handling live canvas commands", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: null },
      openCanvas,
      closeCanvas,
    });

    const latestEvent = createEvent({
      _id: "cmd-latest",
      type: "canvas_command",
      payload: { action: "open", name: "latest" },
    });
    const historicalEvent = createEvent({
      _id: "cmd-history",
      type: "canvas_command",
      payload: { action: "close" },
    });
    const appendedEvent = createEvent({
      _id: "cmd-appended",
      type: "canvas_command",
      payload: { action: "open", name: "appended" },
    });

    const { rerender } = renderHook(({ list }) => useCanvasCommands(list, "conv-1"), {
      initialProps: { list: [latestEvent] },
    });

    expect(openCanvas).toHaveBeenCalledTimes(1);

    rerender({ list: [historicalEvent, latestEvent] });
    expect(closeCanvas).not.toHaveBeenCalled();
    expect(openCanvas).toHaveBeenCalledTimes(1);

    rerender({ list: [historicalEvent, latestEvent, appendedEvent] });
    expect(openCanvas).toHaveBeenCalledTimes(2);
    expect(openCanvas).toHaveBeenLastCalledWith({
      name: "appended",
      title: undefined,
      url: undefined,
    });
  });

  it("closes canvas and kills localhost shell by port", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: { url: "http://127.0.0.1:4173" } },
      openCanvas,
      closeCanvas,
    });

    const events: EventRecord[] = [
      createEvent({
        _id: "cmd-close",
        type: "canvas_command",
        payload: { action: "close" },
      }),
    ];

    renderHook(() => useCanvasCommands(events));

    expect(window.electronAPI?.system.shellKillByPort).toHaveBeenCalledWith(4173);
    expect(closeCanvas).toHaveBeenCalledTimes(1);
  });

  it("closes canvas without killing shell for non-localhost URL", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: { url: "https://example.com/app" } },
      openCanvas,
      closeCanvas,
    });

    const events: EventRecord[] = [
      createEvent({
        _id: "cmd-close-remote",
        type: "canvas_command",
        payload: { action: "close" },
      }),
    ];

    renderHook(() => useCanvasCommands(events));

    expect(window.electronAPI?.system.shellKillByPort).not.toHaveBeenCalled();
    expect(closeCanvas).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed canvas command payloads", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: null },
      openCanvas,
      closeCanvas,
    });

    const events: EventRecord[] = [
      createEvent({ _id: "bad-1", type: "canvas_command", payload: {} }),
      createEvent({ _id: "bad-2", type: "canvas_command", payload: { action: "open" } }),
      createEvent({ _id: "other", type: "assistant_message", payload: { text: "ignore" } }),
    ];

    renderHook(() => useCanvasCommands(events));

    expect(openCanvas).not.toHaveBeenCalled();
    expect(closeCanvas).not.toHaveBeenCalled();
  });

  it("ignores unsafe panel names and URLs", () => {
    const openCanvas = vi.fn();
    const closeCanvas = vi.fn();
    mockUseCanvas.mockReturnValue({
      state: { canvas: null },
      openCanvas,
      closeCanvas,
    });

    const events: EventRecord[] = [
      createEvent({
        _id: "unsafe-name",
        type: "canvas_command",
        payload: { action: "open", name: "../escape", url: "http://localhost:3000" },
      }),
      createEvent({
        _id: "unsafe-url",
        type: "canvas_command",
        payload: { action: "open", name: "safe-panel", url: "javascript:alert(1)" },
      }),
    ];

    renderHook(() => useCanvasCommands(events));
    expect(openCanvas).not.toHaveBeenCalled();
  });
});


