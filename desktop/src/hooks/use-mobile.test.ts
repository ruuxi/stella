import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./use-mobile";

describe("useIsMobile", () => {
  it("returns true when viewport is below breakpoint", () => {
    const listeners: Array<() => void> = [];
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () =>
        ({
          matches: true,
          media: "(max-width: 767px)",
          onchange: null,
          addEventListener: (_: string, cb: () => void) => listeners.push(cb),
          removeEventListener: (_: string, cb: () => void) => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
          dispatchEvent: () => true,
          addListener: () => {},
          removeListener: () => {},
        }) as MediaQueryList,
    });

    Object.defineProperty(window, "innerWidth", { value: 640, configurable: true });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("reacts to media change events and cleans up listeners", () => {
    const listeners: Array<() => void> = [];
    const addEventListener = vi.fn((_: string, cb: () => void) => {
      listeners.push(cb);
    });
    const removeEventListener = vi.fn((_: string, cb: () => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () =>
        ({
          matches: false,
          media: "(max-width: 767px)",
          onchange: null,
          addEventListener,
          removeEventListener,
          dispatchEvent: () => true,
          addListener: () => {},
          removeListener: () => {},
        }) as MediaQueryList,
    });

    Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });

    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    expect(addEventListener).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    act(() => {
      listeners[0]();
    });
    expect(result.current).toBe(true);

    unmount();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});
