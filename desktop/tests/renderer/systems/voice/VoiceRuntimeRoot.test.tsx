import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRuntimeRoot } from "../../../../src/systems/voice/VoiceRuntimeRoot";

const mockUseUiState = vi.fn();
const mockGetOrCreateDeviceId = vi.fn();
const mockManagerStart = vi.fn();
const mockManagerStop = vi.fn();
const mockManagerUpdateSession = vi.fn();
const mockManagerGetAnalyser = vi.fn();
const mockManagerGetOutputAnalyser = vi.fn();
const managerDeps: Array<{
  onStateChange: (
    state: "idle" | "connecting" | "connected" | "error" | "disconnecting",
  ) => void;
}> = [];

vi.mock("@/context/ui-state", () => ({
  useUiState: () => mockUseUiState(),
}));

vi.mock("@/platform/electron/device", () => ({
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
}));

vi.mock("@/features/voice/hooks/use-realtime-voice", () => ({
  VoiceSessionManager: class {
    constructor(
      deps: {
        onStateChange: (
          state:
            | "idle"
            | "connecting"
            | "connected"
            | "error"
            | "disconnecting",
        ) => void;
      },
    ) {
      managerDeps.push(deps);
    }

    start = mockManagerStart;
    stop = mockManagerStop;
    updateSession = mockManagerUpdateSession;
    getAnalyser = mockManagerGetAnalyser;
    getOutputAnalyser = mockManagerGetOutputAnalyser;
  },
}));

describe("VoiceRuntimeRoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerDeps.length = 0;
    mockManagerGetAnalyser.mockReturnValue(null);
    mockManagerGetOutputAnalyser.mockReturnValue(null);
    mockUseUiState.mockReturnValue({
      state: {
        mode: "chat",
        window: "full",
        view: "home",
        conversationId: "conv-1",
        isVoiceActive: false,
        isVoiceRtcActive: false,
      },
    });
    mockGetOrCreateDeviceId.mockResolvedValue("device-1");
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      voice: {
        pushRuntimeState: vi.fn(),
      },
      localChat: {
        getOrCreateDefaultConversationId: vi.fn().mockResolvedValue("conv-1"),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the voice session manager even when rtc input is inactive", () => {
    render(<VoiceRuntimeRoot />);

    expect(mockManagerStart).toHaveBeenCalledTimes(1);
  });

  it("updates the live session with conversation and input-active changes", () => {
    const { rerender } = render(<VoiceRuntimeRoot />);

    mockUseUiState.mockReturnValue({
      state: {
        mode: "voice",
        window: "full",
        view: "home",
        conversationId: "conv-2",
        isVoiceActive: false,
        isVoiceRtcActive: true,
      },
    });

    rerender(<VoiceRuntimeRoot />);

    expect(mockManagerUpdateSession).toHaveBeenCalledWith("conv-2", true);
  });

  it("samples analyser levels from the warm session after it becomes connected", () => {
    vi.useFakeTimers();
    const pushRuntimeState = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      voice: {
        pushRuntimeState,
      },
      localChat: {
        getOrCreateDefaultConversationId: vi.fn().mockResolvedValue("conv-1"),
      },
    };

    const inputAnalyser = {
      frequencyBinCount: 2,
      getByteFrequencyData(buffer: Uint8Array) {
        buffer[0] = 255;
        buffer[1] = 0;
      },
    };
    const outputAnalyser = {
      frequencyBinCount: 2,
      getByteFrequencyData(buffer: Uint8Array) {
        buffer[0] = 128;
        buffer[1] = 128;
      },
    };

    mockManagerGetAnalyser.mockReturnValue(
      inputAnalyser as unknown as AnalyserNode,
    );
    mockManagerGetOutputAnalyser.mockReturnValue(
      outputAnalyser as unknown as AnalyserNode,
    );

    render(<VoiceRuntimeRoot />);

    act(() => {
      managerDeps[0]?.onStateChange("connected");
    });

    act(() => {
      vi.advanceTimersByTime(24);
    });

    expect(pushRuntimeState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionState: "connected",
        isConnected: true,
        micLevel: expect.any(Number),
        outputLevel: expect.any(Number),
      }),
    );

    const lastRuntimeState = pushRuntimeState.mock.calls.at(-1)?.[0];
    expect(lastRuntimeState?.micLevel).toBeGreaterThan(0);
    expect(lastRuntimeState?.outputLevel).toBeGreaterThan(0);
  });
});
