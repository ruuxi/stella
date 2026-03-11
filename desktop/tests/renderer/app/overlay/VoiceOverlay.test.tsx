import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceOverlay } from "../../../../src/app/overlay/VoiceOverlay";

const mockUseUiState = vi.fn();
const mockUseVoiceRecording = vi.fn();
const mockUseRealtimeVoice = vi.fn();
const mockUseWindowType = vi.fn();

vi.mock("@/context/ui-state", () => ({
  useUiState: () => mockUseUiState(),
}));

vi.mock("@/app/voice/hooks/use-voice-recording", () => ({
  useVoiceRecording: (...args: unknown[]) => mockUseVoiceRecording(...args),
}));

vi.mock("@/app/voice/hooks/use-realtime-voice", () => ({
  useRealtimeVoice: () => mockUseRealtimeVoice(),
}));

vi.mock("@/shared/hooks/use-window-type", () => ({
  useWindowType: () => mockUseWindowType(),
}));

vi.mock("@/app/shell/ascii-creature/StellaAnimation", () => ({
  StellaAnimation: () => <div data-testid="stella-animation" />,
}));

describe("VoiceOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    vi.stubGlobal("requestAnimationFrame", ((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0)) as typeof requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", ((id: number) =>
      window.clearTimeout(id)) as typeof cancelAnimationFrame);

    mockUseUiState.mockReturnValue({
      state: {
        mode: "voice",
        window: "overlay",
        view: "home",
        conversationId: "conv-1",
        isVoiceActive: true,
        isVoiceRtcActive: false,
      },
      updateState: vi.fn(),
    });
    mockUseVoiceRecording.mockReturnValue({
      analyserRef: { current: null },
      isRecording: true,
      isTranscribing: false,
    });
    mockUseRealtimeVoice.mockReturnValue({
      micLevel: 0,
      outputLevel: 0,
      isConnected: false,
      isSpeaking: false,
      isUserSpeaking: false,
      sessionState: "idle",
    });
    mockUseWindowType.mockReturnValue("overlay");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not render when voice is active but explicit overlay visibility is false", () => {
    const { container } = render(
      <VoiceOverlay
        onTranscript={vi.fn()}
        visible={false}
        style={{ position: "absolute", left: 24, top: 32 }}
      />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(container.querySelector(".voice-overlay")).toBeNull();
  });

  it("hides after explicit visibility is removed even if shared voice state stays active", () => {
    const { container, rerender } = render(
      <VoiceOverlay
        onTranscript={vi.fn()}
        visible={true}
        style={{ position: "absolute", left: 24, top: 32 }}
      />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(container.querySelector(".voice-overlay")).not.toBeNull();

    rerender(
      <VoiceOverlay onTranscript={vi.fn()} visible={false} style={undefined} />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(container.querySelector(".voice-overlay")).toBeNull();
  });
});
