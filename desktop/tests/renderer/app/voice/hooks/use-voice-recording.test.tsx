import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAcquireSharedMicrophone = vi.fn();
const mockCreateStreamingSession = vi.fn();

vi.mock("@/features/voice/services/shared-microphone", () => ({
  acquireSharedMicrophone: (...args: unknown[]) =>
    mockAcquireSharedMicrophone(...args),
}));

vi.mock("@/features/voice/services/speech-to-text", () => ({
  createStreamingSession: (...args: unknown[]) =>
    mockCreateStreamingSession(...args),
}));

class MockAudioContext {
  state: "running" | "suspended" = "running";
  sampleRate = 48_000;
  destination = {};
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };

  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
  }));
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
  };

  connect = vi.fn();
  disconnect = vi.fn();
}

import { useVoiceRecording } from "../../../../../src/features/voice/hooks/use-voice-recording";

describe("useVoiceRecording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "AudioContext",
      MockAudioContext as unknown as typeof AudioContext,
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      MockAudioWorkletNode as unknown as typeof AudioWorkletNode,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acquires the shared microphone when recording becomes active", async () => {
    const lease = {
      stream: { id: "mic-stream" } as MediaStream,
      release: vi.fn(),
    };
    const session = {
      sendChunk: vi.fn(),
      commit: vi.fn().mockResolvedValue({ text: "" }),
    };

    mockAcquireSharedMicrophone.mockResolvedValue(lease);
    mockCreateStreamingSession.mockReturnValue(session);

    const { result } = renderHook(() =>
      useVoiceRecording({
        isActive: true,
        onTranscript: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(mockAcquireSharedMicrophone).toHaveBeenCalledTimes(1);
      expect(mockCreateStreamingSession).toHaveBeenCalledTimes(1);
      expect(result.current.isRecording).toBe(true);
    });

    expect(mockAcquireSharedMicrophone).toHaveBeenCalledWith({
      useCase: "speech-recording",
    });
  });

  it("releases the microphone lease and commits the transcript when recording stops", async () => {
    const onTranscript = vi.fn();
    const release = vi.fn();
    const commit = vi.fn().mockResolvedValue({ text: "  hello from stt  " });

    mockAcquireSharedMicrophone.mockResolvedValue({
      stream: { id: "mic-stream" } as MediaStream,
      release,
    });
    mockCreateStreamingSession.mockReturnValue({
      sendChunk: vi.fn(),
      commit,
    });

    const { rerender, result } = renderHook(
      ({ isActive }) =>
        useVoiceRecording({
          isActive,
          onTranscript,
        }),
      {
        initialProps: { isActive: true },
      },
    );

    await waitFor(() => {
      expect(result.current.isRecording).toBe(true);
    });

    rerender({ isActive: false });

    await waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(onTranscript).toHaveBeenCalledWith("hello from stt");
      expect(result.current.isRecording).toBe(false);
    });
  });
});
