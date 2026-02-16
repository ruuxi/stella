import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { CanvasProvider, useCanvas, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH_RATIO } from "./canvas-state";

const wrapper = ({ children }: { children: ReactNode }) => (
  <CanvasProvider>{children}</CanvasProvider>
);

describe("CanvasProvider + useCanvas", () => {
  it("starts with canvas closed and default width", () => {
    const { result } = renderHook(() => useCanvas(), { wrapper });
    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.canvas).toBeNull();
    expect(result.current.state.width).toBe(DEFAULT_WIDTH);
  });

  it("opens canvas with a payload", () => {
    const { result } = renderHook(() => useCanvas(), { wrapper });

    act(() => {
      result.current.openCanvas({ name: "test-panel", title: "Test" });
    });

    expect(result.current.state.isOpen).toBe(true);
    expect(result.current.state.canvas).toEqual({ name: "test-panel", title: "Test" });
  });

  it("closes canvas and preserves the last payload", () => {
    const { result } = renderHook(() => useCanvas(), { wrapper });

    act(() => {
      result.current.openCanvas({ name: "my-chart" });
    });
    act(() => {
      result.current.closeCanvas();
    });

    expect(result.current.state.isOpen).toBe(false);
    // Payload is preserved for potential re-open
    expect(result.current.state.canvas).toEqual({ name: "my-chart" });
  });

  it("opens with url payload for iframe rendering", () => {
    const { result } = renderHook(() => useCanvas(), { wrapper });

    act(() => {
      result.current.openCanvas({
        name: "my-app",
        url: "http://localhost:5180",
      });
    });

    expect(result.current.state.canvas?.url).toBe("http://localhost:5180");
  });

  it("clamps width to minimum", () => {
    const { result } = renderHook(() => useCanvas(), { wrapper });

    act(() => {
      result.current.setWidth(100); // Below MIN_WIDTH
    });

    expect(result.current.state.width).toBe(MIN_WIDTH);
  });

  it("clamps width to maximum ratio of viewport", () => {
    // window.innerWidth is typically 1024 in jsdom
    const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
    const { result } = renderHook(() => useCanvas(), { wrapper });

    act(() => {
      result.current.setWidth(5000); // Way above max
    });

    expect(result.current.state.width).toBe(maxWidth);
  });

  it("accepts width within valid range", () => {
    const { result } = renderHook(() => useCanvas(), { wrapper });

    act(() => {
      result.current.setWidth(450);
    });

    expect(result.current.state.width).toBe(450);
  });
});

describe("useCanvas outside provider", () => {
  it("throws when used outside CanvasProvider", () => {
    expect(() => {
      renderHook(() => useCanvas());
    }).toThrow("useCanvas must be used within CanvasProvider");
  });
});

describe("exported constants", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_WIDTH).toBe(560);
    expect(MIN_WIDTH).toBe(320);
    expect(MAX_WIDTH_RATIO).toBe(0.6);
  });
});
