import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRuntimeRoot } from "../../../../src/app/voice-runtime/VoiceRuntimeRoot";

const mockUseUiState = vi.fn();
const mockGetOrCreateDeviceId = vi.fn();
const mockManagerStart = vi.fn();
const mockManagerStop = vi.fn();
const mockManagerUpdateSession = vi.fn();

vi.mock("@/context/ui-state", () => ({
  useUiState: () => mockUseUiState(),
}));

vi.mock("@/platform/electron/device", () => ({
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
}));

vi.mock("@/app/chat/services/local-chat-store", () => ({
  appendLocalEvent: vi.fn(),
}));

vi.mock("@/app/voice/hooks/use-realtime-voice", () => ({
  VoiceSessionManager: class {
    start = mockManagerStart;
    stop = mockManagerStop;
    updateSession = mockManagerUpdateSession;
  },
}));

describe("VoiceRuntimeRoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
