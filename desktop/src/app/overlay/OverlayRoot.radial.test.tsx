import { act, render } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayRoot } from "./OverlayRoot";

vi.mock("./RadialDial", () => ({
  RadialDial: () => <div data-testid="radial-dial" />,
}));

vi.mock("./RegionCapture", () => ({
  RegionCapture: () => <div data-testid="region-capture" />,
}));

vi.mock("../shell/mini/MiniShell", () => ({
  MiniShell: () => <div data-testid="mini-shell" />,
}));

vi.mock("@/app/overlay/VoiceOverlay", () => ({
  VoiceOverlay: ({ style }: { style?: CSSProperties }) => (
    <div data-testid="voice-overlay" style={style} />
  ),
}));

vi.mock("@/app/overlay/MorphTransition", () => ({
  MorphTransition: () => null,
}));

let showCallback: ((event: unknown, data: { centerX: number; centerY: number; screenX?: number; screenY?: number }) => void) | null = null;
let hideCallback: (() => void) | null = null;

describe("OverlayRoot radial lifecycle", () => {
  beforeEach(() => {
    showCallback = null;
    hideCallback = null;
    vi.useFakeTimers();

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
        onCursor: vi.fn(() => vi.fn()),
        animDone: vi.fn(),
      },
      overlay: {
        setInteractive: vi.fn(),
        onModifierBlock: vi.fn(() => vi.fn()),
        onStartRegionCapture: vi.fn(() => vi.fn()),
        onEndRegionCapture: vi.fn(() => vi.fn()),
        onShowMini: vi.fn(() => vi.fn()),
        onHideMini: vi.fn(() => vi.fn()),
        onRestoreMini: vi.fn(() => vi.fn()),
        onShowVoice: vi.fn(() => vi.fn()),
        onHideVoice: vi.fn(() => vi.fn()),
      },
      voice: {
        submitTranscript: vi.fn(),
        getRuntimeState: vi.fn().mockResolvedValue({
          sessionState: "idle",
          isConnected: false,
          isSpeaking: false,
          isUserSpeaking: false,
          micLevel: 0,
          outputLevel: 0,
        }),
        onRuntimeState: vi.fn(() => vi.fn()),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).electronAPI;
  });

  it("cancels a pending radial shell hide when the dial is reopened", () => {
    const { container } = render(<OverlayRoot />);
    const shell = container.querySelector(".radial-shell") as HTMLDivElement;

    act(() => {
      showCallback?.(null, { centerX: 140, centerY: 140, screenX: 48, screenY: 72 });
    });

    expect(shell.style.left).toBe("48px");
    expect(shell.style.top).toBe("72px");
    expect(shell.style.pointerEvents).toBe("auto");

    act(() => {
      hideCallback?.();
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    act(() => {
      showCallback?.(null, { centerX: 140, centerY: 140, screenX: 48, screenY: 72 });
    });

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(shell.style.left).toBe("48px");
    expect(shell.style.top).toBe("72px");
    expect(shell.style.pointerEvents).toBe("auto");
  });
});
