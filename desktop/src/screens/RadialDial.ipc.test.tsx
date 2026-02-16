import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";

// ---------- Mocks ----------

// Return a truthy value so the useEffect IPC branch runs
vi.mock("../services/electron", () => ({
  getElectronApi: () => ({ platform: "win32" }),
}));

vi.mock("../theme/theme-context", () => ({
  useTheme: () => ({
    colors: {
      interactive: "#ff0000",
      card: "#111111",
      border: "#333333",
      primaryForeground: "#ffffff",
      mutedForeground: "#888888",
      background: "#000000",
    },
  }),
}));

vi.mock("../components/StellaAnimation", () => ({
  StellaAnimation: () => <div data-testid="stella-animation" />,
}));

vi.mock("../theme/color", () => ({
  hexToRgb: (hex: string) => {
    const h = hex.replace("#", "");
    const num = parseInt(h, 16);
    return {
      r: ((num >> 16) & 255) / 255,
      g: ((num >> 8) & 255) / 255,
      b: (num & 255) / 255,
    };
  },
  generateGradientTokens: vi.fn(),
}));

import { RadialDial } from "./RadialDial";

// ---------- Helpers ----------

// Constants from RadialDial.tsx
const SIZE = 280;
const CENTER = SIZE / 2; // 140
const DEAD_ZONE_RADIUS = 30;

// Capture the IPC handler callbacks so tests can invoke them
let showCallback: Function;
let hideCallback: Function;
let cursorCallback: Function;

let cleanupShow: ReturnType<typeof vi.fn>;
let cleanupHide: ReturnType<typeof vi.fn>;
let cleanupCursor: ReturnType<typeof vi.fn>;

// Store rAF callbacks for manual flushing
let rafCallbacks: Function[];

describe("RadialDial IPC handlers", () => {
  beforeEach(() => {
    rafCallbacks = [];
    const rAF = vi.fn((cb: Function) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    const cAF = vi.fn();
    vi.stubGlobal("requestAnimationFrame", rAF);
    vi.stubGlobal("cancelAnimationFrame", cAF);

    cleanupShow = vi.fn();
    cleanupHide = vi.fn();
    cleanupCursor = vi.fn();

    (window as any).electronAPI = {
      platform: "win32",
      onRadialShow: vi.fn((cb: Function) => {
        showCallback = cb;
        return cleanupShow;
      }),
      onRadialHide: vi.fn((cb: Function) => {
        hideCallback = cb;
        return cleanupHide;
      }),
      onRadialCursor: vi.fn((cb: Function) => {
        cursorCallback = cb;
        return cleanupCursor;
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).electronAPI;
  });

  /** Flush all pending requestAnimationFrame callbacks inside an act() */
  function flushRAF() {
    act(() => {
      const cbs = rafCallbacks.splice(0);
      cbs.forEach((cb) => cb());
    });
  }

  // ----------------------------------------------------------------
  // 1. Registers IPC listeners on mount
  // ----------------------------------------------------------------
  it("registers IPC listeners on mount when electronAPI is available", () => {
    render(<RadialDial />);

    expect(window.electronAPI!.onRadialShow).toHaveBeenCalledTimes(1);
    expect(window.electronAPI!.onRadialHide).toHaveBeenCalledTimes(1);
    expect(window.electronAPI!.onRadialCursor).toHaveBeenCalledTimes(1);

    // Each should have been called with a function (the handler)
    expect(typeof (window.electronAPI!.onRadialShow as any).mock.calls[0][0]).toBe("function");
    expect(typeof (window.electronAPI!.onRadialHide as any).mock.calls[0][0]).toBe("function");
    expect(typeof (window.electronAPI!.onRadialCursor as any).mock.calls[0][0]).toBe("function");
  });

  // ----------------------------------------------------------------
  // 2. Cleans up IPC listeners on unmount
  // ----------------------------------------------------------------
  it("cleans up IPC listeners on unmount", () => {
    const { unmount } = render(<RadialDial />);

    expect(cleanupShow).not.toHaveBeenCalled();
    expect(cleanupHide).not.toHaveBeenCalled();
    expect(cleanupCursor).not.toHaveBeenCalled();

    unmount();

    expect(cleanupShow).toHaveBeenCalledTimes(1);
    expect(cleanupHide).toHaveBeenCalledTimes(1);
    expect(cleanupCursor).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // 3. onRadialShow with coordinates selects correct wedge
  // ----------------------------------------------------------------
  it("onRadialShow with coordinates selects correct wedge", () => {
    const { container } = render(<RadialDial />);

    // x=140, y=10 relative to a center of 140,140 means straight up.
    // dx=0, dy=-130, distance=130 (> DEAD_ZONE_RADIUS=30)
    // angle = atan2(-130, 0) * (180/PI) = -90, after +360 = 270
    // (270 + 90) % 360 = 0
    // wedgeIndex = floor(0 / 72) = 0 => WEDGES[0] = "capture"
    act(() => {
      showCallback(null, { centerX: 140, centerY: 140, x: 140, y: 10 });
    });

    flushRAF();

    const paths = container.querySelectorAll("path.wedge-path");
    // The first wedge (index 0 = capture) should have the interactive fill color
    const captureFill = paths[0].getAttribute("fill");
    expect(captureFill).toBe("rgba(255, 0, 0, 0.9)");

    // Other wedges should stay at the card color
    for (let i = 1; i < paths.length; i++) {
      expect(paths[i].getAttribute("fill")).toBe("#111111");
    }
  });

  // ----------------------------------------------------------------
  // 4. onRadialShow without coordinates selects dismiss
  // ----------------------------------------------------------------
  it("onRadialShow without coordinates selects dismiss", () => {
    const { container } = render(<RadialDial />);

    act(() => {
      showCallback(null, { centerX: 140, centerY: 140 });
    });

    flushRAF();

    const paths = container.querySelectorAll("path.wedge-path");
    // No wedge should be selected — all should have card color fill
    paths.forEach((path) => {
      expect(path.getAttribute("fill")).toBe("#111111");
    });
  });

  // ----------------------------------------------------------------
  // 5. onRadialShow triggers animateIn via requestAnimationFrame
  // ----------------------------------------------------------------
  it("onRadialShow triggers animateIn via requestAnimationFrame", () => {
    const { container } = render(<RadialDial />);
    const frame = container.querySelector(".radial-dial-frame")!;

    // Before show, not visible
    expect(frame.classList.contains("radial-dial-frame--visible")).toBe(false);

    act(() => {
      showCallback(null, { centerX: 140, centerY: 140 });
    });

    // After show but before rAF flush, still not visible (setAnimateIn(false) was called)
    expect(frame.classList.contains("radial-dial-frame--visible")).toBe(false);

    // Flush the rAF to trigger setAnimateIn(true)
    flushRAF();

    expect(frame.classList.contains("radial-dial-frame--visible")).toBe(true);
  });

  // ----------------------------------------------------------------
  // 6. onRadialHide resets selectedWedge and animateIn
  // ----------------------------------------------------------------
  it("onRadialHide resets selectedWedge and animateIn", () => {
    const { container } = render(<RadialDial />);

    // First, show the dial with a wedge selected
    act(() => {
      showCallback(null, { centerX: 140, centerY: 140, x: 140, y: 10 });
    });
    flushRAF();

    const frame = container.querySelector(".radial-dial-frame")!;
    expect(frame.classList.contains("radial-dial-frame--visible")).toBe(true);

    // Now hide
    act(() => {
      hideCallback();
    });

    // animateIn should be false
    expect(frame.classList.contains("radial-dial-frame--visible")).toBe(false);

    // All wedge fills should be back to card color (dismiss state)
    const paths = container.querySelectorAll("path.wedge-path");
    paths.forEach((path) => {
      expect(path.getAttribute("fill")).toBe("#111111");
    });
  });

  // ----------------------------------------------------------------
  // 7. onRadialCursor updates wedge selection
  // ----------------------------------------------------------------
  it("onRadialCursor updates wedge selection", () => {
    const { container } = render(<RadialDial />);

    // Show the dial first so visibleRef.current = true
    act(() => {
      showCallback(null, { centerX: 140, centerY: 140 });
    });
    flushRAF();

    // Now send a cursor event pointing to wedge index 2 (right side)
    // We need angle that maps to index 2: index 2 => angle in [144, 216)
    // Adjusted angle = (atan2(dy,dx)*180/PI + 360 + 90) % 360
    // For straight down: dx=0, dy=+100 => atan2 = 90deg, adjusted = (90+90)%360 = 180
    // wedgeIndex = floor(180/72) = 2 => WEDGES[2] = "full"
    act(() => {
      cursorCallback(null, { x: 140, y: 240, centerX: 140, centerY: 140 });
    });

    const paths = container.querySelectorAll("path.wedge-path");
    // Index 2 = "full" should be selected
    expect(paths[2].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");

    // Now move cursor to a different wedge — straight right:
    // dx=+100, dy=0 => atan2=0, adjusted=(0+90)%360=90
    // wedgeIndex = floor(90/72) = 1 => WEDGES[1] = "chat"
    act(() => {
      cursorCallback(null, { x: 240, y: 140, centerX: 140, centerY: 140 });
    });

    expect(paths[1].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");
    // The previously selected wedge should revert
    expect(paths[2].getAttribute("fill")).toBe("#111111");
  });

  // ----------------------------------------------------------------
  // 8. onRadialCursor is ignored when not visible
  // ----------------------------------------------------------------
  it("onRadialCursor is ignored when not visible", () => {
    const { container } = render(<RadialDial />);

    // Without calling showCallback first, visibleRef.current is false
    act(() => {
      cursorCallback(null, { x: 140, y: 10, centerX: 140, centerY: 140 });
    });

    const paths = container.querySelectorAll("path.wedge-path");
    // All wedges should remain at card color (dismiss)
    paths.forEach((path) => {
      expect(path.getAttribute("fill")).toBe("#111111");
    });
  });

  // ----------------------------------------------------------------
  // 9. calculateWedge returns dismiss when in dead zone
  // ----------------------------------------------------------------
  it("calculateWedge returns dismiss when cursor is in dead zone", () => {
    const { container } = render(<RadialDial />);

    // Show first, then move cursor close to center
    act(() => {
      showCallback(null, { centerX: 140, centerY: 140 });
    });
    flushRAF();

    // Cursor at center + 10 pixels — well within DEAD_ZONE_RADIUS=30
    act(() => {
      cursorCallback(null, { x: 150, y: 140, centerX: 140, centerY: 140 });
    });

    // All wedges should have card color (dismiss state)
    const paths = container.querySelectorAll("path.wedge-path");
    paths.forEach((path) => {
      expect(path.getAttribute("fill")).toBe("#111111");
    });
  });

  // ----------------------------------------------------------------
  // 10. calculateWedge returns correct wedge for each section
  // ----------------------------------------------------------------
  it("calculateWedge returns correct wedge for each section", () => {
    const { container } = render(<RadialDial />);

    // Show so visibleRef=true
    act(() => {
      showCallback(null, { centerX: CENTER, centerY: CENTER });
    });
    flushRAF();

    const paths = container.querySelectorAll("path.wedge-path");

    // WEDGES = [capture(0), chat(1), full(2), voice(3), auto(4)]
    // adjusted angle = (atan2(dy,dx)*180/PI + 360 + 90) % 360
    // wedgeIndex = floor(adjusted / 72)

    // Helper to compute angle-based wedge index
    const toWedgeIndex = (dx: number, dy: number) => {
      let angle = Math.atan2(dy, dx) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      angle = (angle + 90) % 360;
      return Math.floor(angle / 72);
    };

    // Test case A: Straight up => capture (index 0)
    // dx=0, dy=-100 => atan2=-90 => +360=270 => +90=360%360=0 => index 0
    expect(toWedgeIndex(0, -100)).toBe(0);
    act(() => {
      cursorCallback(null, { x: CENTER, y: CENTER - 100, centerX: CENTER, centerY: CENTER });
    });
    expect(paths[0].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");

    // Test case B: Straight right => chat (index 1)
    // dx=+100, dy=0 => atan2=0 => +90=90 => index floor(90/72)=1
    expect(toWedgeIndex(100, 0)).toBe(1);
    act(() => {
      cursorCallback(null, { x: CENTER + 100, y: CENTER, centerX: CENTER, centerY: CENTER });
    });
    expect(paths[1].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");
    expect(paths[0].getAttribute("fill")).toBe("#111111");

    // Test case C: Straight down => full (index 2)
    // dx=0, dy=+100 => atan2=90 => +90=180 => index floor(180/72)=2
    expect(toWedgeIndex(0, 100)).toBe(2);
    act(() => {
      cursorCallback(null, { x: CENTER, y: CENTER + 100, centerX: CENTER, centerY: CENTER });
    });
    expect(paths[2].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");
    expect(paths[1].getAttribute("fill")).toBe("#111111");

    // Test case D: Straight left => voice (index 3)
    // dx=-100, dy=0 => atan2=180 => +90=270 => index floor(270/72)=3
    expect(toWedgeIndex(-100, 0)).toBe(3);
    act(() => {
      cursorCallback(null, { x: CENTER - 100, y: CENTER, centerX: CENTER, centerY: CENTER });
    });
    expect(paths[3].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");
    expect(paths[2].getAttribute("fill")).toBe("#111111");

    // Test case E: Upper-left => auto (index 4)
    // dx=-100, dy=-50 => atan2 ~ -153.43 => +360=206.57 => +90=296.57 => index floor(296.57/72)=4
    expect(toWedgeIndex(-100, -50)).toBe(4);
    act(() => {
      cursorCallback(null, { x: CENTER - 100, y: CENTER - 50, centerX: CENTER, centerY: CENTER });
    });
    expect(paths[4].getAttribute("fill")).toBe("rgba(255, 0, 0, 0.9)");
    expect(paths[3].getAttribute("fill")).toBe("#111111");
  });
});

// ----------------------------------------------------------------
// toRgba fallback path
// ----------------------------------------------------------------
describe("toRgba fallback (non-hex color)", () => {
  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: Function) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    cleanupShow = vi.fn();
    cleanupHide = vi.fn();
    cleanupCursor = vi.fn();

    (window as any).electronAPI = {
      platform: "win32",
      onRadialShow: vi.fn((cb: Function) => {
        showCallback = cb;
        return cleanupShow;
      }),
      onRadialHide: vi.fn((cb: Function) => {
        hideCallback = cb;
        return cleanupHide;
      }),
      onRadialCursor: vi.fn((cb: Function) => {
        cursorCallback = cb;
        return cleanupCursor;
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).electronAPI;
  });

  it("when color does not start with '#', toRgba returns the color unchanged", async () => {
    // Override useTheme to return a non-hex interactive color (e.g. oklch).
    // toRgba should return it unchanged since it doesn't start with '#'.
    const themeModule = await import("../theme/theme-context");
    const spy = vi.spyOn(themeModule, "useTheme").mockReturnValue({
      colors: {
        interactive: "oklch(0.7 0.2 30)",  // non-hex — should pass through unchanged
        card: "#111111",
        border: "#333333",
        primaryForeground: "#ffffff",
        mutedForeground: "#888888",
        background: "#000000",
      },
    } as any);

    const { container } = render(<RadialDial />);

    // Show with coordinates to select a wedge (capture = index 0)
    act(() => {
      showCallback(null, { centerX: 140, centerY: 140, x: 140, y: 10 });
    });

    // Flush rAF
    act(() => {
      const cbs = rafCallbacks.splice(0);
      cbs.forEach((cb) => cb());
    });

    const paths = container.querySelectorAll("path.wedge-path");
    // The selected wedge fill should be the non-hex color returned unchanged
    // (toRgba fallback: doesn't start with '#', returns color as-is)
    expect(paths[0].getAttribute("fill")).toBe("oklch(0.7 0.2 30)");

    spy.mockRestore();
  });
});
