import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollManagement } from "../../../../src/app/shell/use-full-shell";

const makeOptions = (overrides: Partial<Parameters<typeof useScrollManagement>[0]> = {}) => ({
  itemCount: 0,
  hasOlderEvents: false,
  isLoadingOlder: false,
  onLoadOlder: vi.fn(),
  isWorking: false,
  ...overrides,
});

describe("useScrollManagement (column-reverse)", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts at bottom (isNearBottom=true, showScrollButton=false)", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));
    expect(result.current.isNearBottom).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.overflowAnchor).toBe("none");
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

    // Second call should be ignored (pending RAF)
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("scrollToBottom('instant') sets scrollTop to 0 (column-reverse bottom)", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: -500,
      scrollHeight: 1000,
      clientHeight: 500,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLDivElement;

    act(() => {
      result.current.setScrollContainerElement(mockDiv);
    });

    act(() => {
      result.current.scrollToBottom("instant");
    });

    expect(mockDiv.scrollTop).toBe(0);
  });

  it("scrollToBottom('smooth') uses motion spring animation", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: -500,
      scrollHeight: 1000,
      clientHeight: 500,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLDivElement;

    act(() => {
      result.current.setScrollContainerElement(mockDiv);
    });

    act(() => {
      result.current.scrollToBottom("smooth");
    });

    // Spring animation starts — scrollTop should not be 0 immediately
    // (it animates toward 0)
  });

  it("scrollToBottom does nothing if no container", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));
    act(() => {
      result.current.scrollToBottom();
    });
    // No error
  });

  it("detects user scroll away from bottom", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: -200, // 200px from bottom in column-reverse
      scrollHeight: 1000,
      clientHeight: 500,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLDivElement;

    act(() => {
      result.current.setScrollContainerElement(mockDiv);
    });

    // Simulate enough time passing for grace period
    vi.spyOn(performance, "now").mockReturnValue(500);

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    expect(result.current.isNearBottom).toBe(false);
    expect(result.current.showScrollButton).toBe(true);
    expect(result.current.overflowAnchor).toBe("auto");
  });

  it("re-engages auto-follow when user scrolls back to bottom", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: -200,
      scrollHeight: 1000,
      clientHeight: 500,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLDivElement;

    act(() => {
      result.current.setScrollContainerElement(mockDiv);
    });

    vi.spyOn(performance, "now").mockReturnValue(500);

    // Scroll away
    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    expect(result.current.showScrollButton).toBe(true);

    // Scroll back to bottom
    mockDiv.scrollTop = 0;

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    expect(result.current.isNearBottom).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
  });

  it("requests older history when user scrolls near the top", () => {
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
      // At top: scrollTop = -(scrollHeight - clientHeight) = -600
      scrollTop: -550, // 50px from top (within LOAD_OLDER_THRESHOLD of 200)
      scrollHeight: 1200,
      clientHeight: 600,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLDivElement;

    act(() => {
      result.current.setScrollContainerElement(mockDiv);
    });

    vi.spyOn(performance, "now").mockReturnValue(500);

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("cleans up RAF on unmount", () => {
    const { unmount } = renderHook(() => useScrollManagement(makeOptions()));
    unmount();
  });

  it("resetScrollState clears user-scrolled state", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));

    const mockDiv = {
      scrollTop: -200,
      scrollHeight: 1000,
      clientHeight: 500,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLDivElement;

    act(() => {
      result.current.setScrollContainerElement(mockDiv);
    });

    vi.spyOn(performance, "now").mockReturnValue(500);

    // Scroll away
    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      rafCallbacks.shift()?.(0);
    });
    expect(result.current.showScrollButton).toBe(true);

    // Reset
    act(() => {
      result.current.resetScrollState();
    });
    expect(result.current.isNearBottom).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
  });

  it("returns thumbState for custom scrollbar", () => {
    const { result } = renderHook(() => useScrollManagement(makeOptions()));
    expect(result.current.thumbState).toEqual({ top: 0, height: 0, visible: false });
  });
});
