import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollManagement } from "./use-full-shell";

const makeOptions = (overrides: Partial<Parameters<typeof useScrollManagement>[0]> = {}) => ({
  itemCount: 0,
  hasOlderEvents: false,
  isLoadingOlder: false,
  onLoadOlder: vi.fn(),
  ...overrides,
});

describe("useScrollManagement", () => {
  let rafCallbacks: FrameRequestCallback[];
  const createRect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });

  beforeEach(() => {
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts near bottom", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));
    expect(result.current.isNearBottom).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
  });

  it("provides a scrollContainerRef", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));
    expect(result.current.scrollContainerRef).toBeDefined();
  });

  it("handleScroll batches via requestAnimationFrame", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    act(() => {
      result.current.handleScroll();
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleScroll();
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("scrollToBottom calls scrollTo on the container", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTo: vi.fn(),
    } as unknown as HTMLDivElement;

    (result.current.scrollContainerRef as { current: HTMLDivElement }).current = mockDiv;

    act(() => {
      result.current.scrollToBottom();
    });

    expect(mockDiv.scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "smooth",
    });
  });

  it("scrollToBottom accepts custom behavior", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTo: vi.fn(),
    } as unknown as HTMLDivElement;

    (result.current.scrollContainerRef as { current: HTMLDivElement }).current = mockDiv;

    act(() => {
      result.current.scrollToBottom("instant");
    });

    expect(mockDiv.scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "instant",
    });
  });

  it("scrollToBottom does nothing if no container", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));
    act(() => {
      result.current.scrollToBottom();
    });
  });

  it("cleans up RAF on unmount", () => {
    const { unmount } = renderHook(() => useScrollManagement(makeOptions()));

    unmount();
  });

  it("requests older history when the user scrolls to the top", () => {
    const onLoadOlder = vi.fn();
    const { result } = renderHook(() =>
      useScrollManagement(
        makeOptions({
          itemCount: 20,
          hasOlderEvents: true,
          onLoadOlder,
        }),
      ),
    );

    const mockDiv = {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
      scrollTo: vi.fn(),
    } as unknown as HTMLDivElement;

    (result.current.scrollContainerRef as { current: HTMLDivElement }).current = mockDiv;

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("preserves scroll position after older messages are prepended", () => {
    const onLoadOlder = vi.fn();
    const { result, rerender } = renderHook(
      (options: ReturnType<typeof makeOptions>) => useScrollManagement(options),
      {
        initialProps: makeOptions({
          itemCount: 20,
          hasOlderEvents: true,
          onLoadOlder,
        }),
      },
    );

    const mockDiv = {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
      scrollTo: vi.fn(),
    } as unknown as HTMLDivElement;

    (result.current.scrollContainerRef as { current: HTMLDivElement }).current = mockDiv;

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    Object.defineProperty(mockDiv, "scrollHeight", {
      value: 1800,
      configurable: true,
      writable: true,
    });

    rerender(
      makeOptions({
        itemCount: 40,
        hasOlderEvents: true,
        onLoadOlder,
      }),
    );

    expect(mockDiv.scrollTop).toBe(600);
  });

  it("preserves the scroll anchor when older history loads while the bottom grows", () => {
    const onLoadOlder = vi.fn();
    const { result, rerender } = renderHook(
      (options: ReturnType<typeof makeOptions>) => useScrollManagement(options),
      {
        initialProps: makeOptions({
          itemCount: 20,
          hasOlderEvents: true,
          onLoadOlder,
        }),
      },
    );

    let anchorTop = 20;
    const anchorElement = {
      dataset: { turnId: "turn-20" },
      getBoundingClientRect: vi.fn(() => createRect(anchorTop, 120)),
    } as unknown as HTMLElement;

    const mockDiv = {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
      scrollTo: vi.fn(),
      querySelectorAll: vi.fn(() => [anchorElement]),
      getBoundingClientRect: vi.fn(() => createRect(0, 600)),
    } as unknown as HTMLDivElement;

    (result.current.scrollContainerRef as { current: HTMLDivElement }).current = mockDiv;

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    anchorTop = 620;
    Object.defineProperty(mockDiv, "scrollHeight", {
      value: 2100,
      configurable: true,
      writable: true,
    });

    rerender(
      makeOptions({
        itemCount: 40,
        hasOlderEvents: true,
        onLoadOlder,
      }),
    );

    expect(mockDiv.scrollTop).toBe(600);
  });
});
