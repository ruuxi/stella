import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/electron/electron", () => ({
  getElectronApi: () => ({ platform: "win32" }),
}));

vi.mock("@/context/theme-context", () => ({
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

vi.mock("@/shell/ascii-creature/StellaAnimation", () => ({
  StellaAnimation: () => <div data-testid="stella-animation" />,
}));

let closeComplete: (() => void) | null = null;

vi.mock("../../../../src/shell/overlay/radial-blob", () => ({
  initBlob: vi.fn(() => true),
  startOpen: vi.fn(
    (
      _selIdxRef: unknown,
      _colorsRef: unknown,
      onComplete: () => void,
      onFadeIn?: () => void,
    ) => {
      onFadeIn?.();
      onComplete();
    },
  ),
  startClose: vi.fn(
    (
      _selIdxRef: unknown,
      _colorsRef: unknown,
      onComplete: () => void,
    ) => {
      closeComplete = onComplete;
    },
  ),
  cancelAnimation: vi.fn(),
  destroyBlob: vi.fn(),
}));

import { RadialDial } from "../../../../src/shell/overlay/RadialDial";

let showCallback: ((event: unknown, data: { centerX: number; centerY: number; x?: number; y?: number }) => void) | null = null;
let hideCallback: (() => void) | null = null;
let _cursorCallback: ((event: unknown, data: { x: number; y: number; centerX: number; centerY: number }) => void) | null = null;
let rafCallbacks: FrameRequestCallback[] = [];

describe("RadialDial close races", () => {
  beforeEach(() => {
    closeComplete = null;
    rafCallbacks = [];

    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    (window as any).electronAPI = {
      platform: "win32",
      radial: {
        onShow: vi.fn((cb: typeof showCallback) => {
          showCallback = cb;
          return vi.fn();
        }),
        onHide: vi.fn((cb: typeof hideCallback) => {
          hideCallback = cb;
          return vi.fn();
        }),
        onCursor: vi.fn((cb: typeof _cursorCallback) => {
          _cursorCallback = cb;
          return vi.fn();
        }),
        animDone: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).electronAPI;
  });

  const flushRaf = () => {
    act(() => {
      const callbacks = rafCallbacks.splice(0);
      callbacks.forEach((cb) => cb(performance.now()));
    });
  };

  it("ignores stale close completion after the dial is reopened", () => {
    render(<RadialDial />);

    act(() => {
      showCallback?.(null, { centerX: 140, centerY: 140, x: 140, y: 10 });
    });

    act(() => {
      hideCallback?.();
    });

    expect(closeComplete).toBeTypeOf("function");

    act(() => {
      showCallback?.(null, { centerX: 140, centerY: 140, x: 240, y: 140 });
    });

    act(() => {
      closeComplete?.();
    });
    flushRaf();

    expect((window as any).electronAPI.radial.animDone).not.toHaveBeenCalled();
  });
});


