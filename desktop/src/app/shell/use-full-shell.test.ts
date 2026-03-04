import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollManagement } from "./use-full-shell";

describe("useScrollManagement", () => {
  let rafCallbacks: FrameRequestCallback[];

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
    const { result } = renderHook(() => useScrollManagement());
    expect(result.current.isNearBottom).toBe(true);
    expect(result.current.showScrollButton).toBe(false);
  });

  it("provides a scrollContainerRef", () => {
    const { result } = renderHook(() => useScrollManagement());
    expect(result.current.scrollContainerRef).toBeDefined();
  });

  it("handleScroll batches via requestAnimationFrame", () => {
    const { result } = renderHook(() => useScrollManagement());

    // Calling handleScroll should schedule a RAF
    act(() => {
      result.current.handleScroll();
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    // Calling again before RAF fires should be no-op
    act(() => {
      result.current.handleScroll();
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("scrollToBottom calls scrollTo on the container", () => {
    const { result } = renderHook(() => useScrollManagement());

    // Set up a mock container
    const mockDiv = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTo: vi.fn(),
    } as unknown as HTMLDivElement;

    // Manually assign the ref
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
    const { result } = renderHook(() => useScrollManagement());

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
    const { result } = renderHook(() => useScrollManagement());
    // Should not throw
    act(() => {
      result.current.scrollToBottom();
    });
  });

  it("cleans up RAF on unmount", () => {
    const { unmount } = renderHook(() => useScrollManagement());

    unmount();
    // cancelAnimationFrame should be called if there was a pending RAF
    // Since no handleScroll was called, it should not error
  });
});
