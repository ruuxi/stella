import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatVoiceSessionDuration,
  shouldPersistVoiceTranscriptToHistory,
  VoiceSessionManager,
} from "@/features/voice/hooks/use-realtime-voice";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRealtimeVoice transcript persistence", () => {
  it("persists finalized user voice transcripts for hidden history", () => {
    expect(
      shouldPersistVoiceTranscriptToHistory({
        type: "user-transcript",
        text: "Please check NVIDIA news.",
        isFinal: true,
      }),
    ).toBe(true);
  });

  it("persists finalized assistant voice transcripts for hidden history", () => {
    expect(
      shouldPersistVoiceTranscriptToHistory({
        type: "assistant-transcript",
        text: "I found the latest NVIDIA news.",
        isFinal: true,
      }),
    ).toBe(true);
  });

  it("ignores partial assistant transcript deltas", () => {
    expect(
      shouldPersistVoiceTranscriptToHistory({
        type: "assistant-transcript",
        text: "I found",
        isFinal: false,
      }),
    ).toBe(false);
  });

  it("formats voice session durations for the visible summary row", () => {
    expect(formatVoiceSessionDuration(420)).toBe("0s");
    expect(formatVoiceSessionDuration(12_400)).toBe("12s");
    expect(formatVoiceSessionDuration(84_100)).toBe("1m 24s");
  });

  it("writes a visible assistant voice-session summary when voice deactivates", () => {
    const persistTranscript = vi.fn();
    vi.stubGlobal("window", {
      electronAPI: {
        voice: {
          persistTranscript,
        },
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const manager = new VoiceSessionManager({
      conversationIdRef: { current: "conv-1" },
      inputActiveRef: { current: false },
      analyserRef: { current: null },
      outputAnalyserRef: { current: null },
      onStateChange: vi.fn(),
      onSpeakingChange: vi.fn(),
      onUserSpeakingChange: vi.fn(),
    });

    manager.updateSession("conv-1", true);
    vi.setSystemTime(85_000);
    manager.updateSession("conv-1", false);

    expect(persistTranscript).toHaveBeenCalledTimes(1);
    expect(persistTranscript).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "assistant",
      text: "Voice session\n\nDuration: 1m 24s",
      uiVisibility: "visible",
      voiceSession: { durationMs: 84_000 },
    });
  });
});
