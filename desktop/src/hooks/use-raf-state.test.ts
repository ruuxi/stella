import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRafState, useRafStringAccumulator } from "./use-raf-state";

describe("useRafState", () => {
  let rafCallbacks: Array<FrameRequestCallback> = [];
  let rafId = 0;

  beforeEach(() => {
    rafCallbacks = [];
    rafId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      rafId += 1;
      return rafId;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("batches multiple updates into a single RAF state commit", () => {
    const { result } = renderHook(() => useRafState(0));

    act(() => {
      const [, setRafState] = result.current;
      setRafState(1);
      setRafState((prev) => prev + 1);
      setRafState(10);
    });

    // ref updates synchronously, state waits for RAF callback
    expect(result.current[2].current).toBe(10);
    expect(result.current[0]).toBe(0);
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      const cb = rafCallbacks.shift();
      if (cb) cb(performance.now());
    });

    expect(result.current[0]).toBe(10);
  });

  it("accumulates and resets text via RAF string accumulator", () => {
    const { result } = renderHook(() => useRafStringAccumulator());

    act(() => {
      const [, append] = result.current;
      append("Hello");
      append(" ");
      append("World");
    });

    expect(result.current[3].current).toBe("Hello World");
    expect(result.current[0]).toBe("");

    act(() => {
      const cb = rafCallbacks.shift();
      if (cb) cb(performance.now());
    });
    expect(result.current[0]).toBe("Hello World");

    act(() => {
      const [, , reset] = result.current;
      reset();
    });
    expect(result.current[3].current).toBe("");

    act(() => {
      const cb = rafCallbacks.shift();
      if (cb) cb(performance.now());
    });
    expect(result.current[0]).toBe("");
  });
});
