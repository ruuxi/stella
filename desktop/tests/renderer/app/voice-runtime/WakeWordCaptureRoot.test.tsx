import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WakeWordCaptureRoot } from "../../../../src/systems/voice/WakeWordCaptureRoot";

const mockUseUiState = vi.fn();
const mockAcquireSharedMicrophone = vi.fn();
const mockBufferRecentVoiceHandoffPcm = vi.fn();
const mockResampleLinear = vi.fn();
const mockFloatToInt16Pcm = vi.fn();

let lastWorkletNode: {
  port: {
    onmessage: ((event: MessageEvent<Float32Array>) => void) | null;
  };
} | null = null;

vi.mock("@/context/ui-state", () => ({
  useUiState: () => mockUseUiState(),
}));

vi.mock("@/features/voice/services/shared-microphone", () => ({
  acquireSharedMicrophone: () => mockAcquireSharedMicrophone(),
  bufferRecentVoiceHandoffPcm: (...args: unknown[]) =>
    mockBufferRecentVoiceHandoffPcm(...args),
}));

vi.mock("@/features/voice/services/audio-encoding", () => ({
  TARGET_WAV_SAMPLE_RATE: 16000,
  resampleLinear: (...args: unknown[]) => mockResampleLinear(...args),
  floatToInt16Pcm: (...args: unknown[]) => mockFloatToInt16Pcm(...args),
}));

class MockAudioContext {
  state: "running" | "suspended" = "running";
  sampleRate = 48000;
  destination = { connect: vi.fn(), disconnect: vi.fn() };
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };

  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
  };

  constructor() {
    lastWorkletNode = this;
  }

  connect = vi.fn();
  disconnect = vi.fn();
}

describe("WakeWordCaptureRoot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    lastWorkletNode = null;
    mockUseUiState.mockReturnValue({
      state: {
        mode: "chat",
        window: "overlay",
        view: "home",
        conversationId: "conv-1",
        isVoiceActive: false,
        isVoiceRtcActive: false,
      },
    });
    mockAcquireSharedMicrophone.mockResolvedValue({
      stream: { id: "mic-stream" },
      release: vi.fn(),
    });
    mockResampleLinear.mockImplementation((samples: Float32Array) => samples);
    mockFloatToInt16Pcm.mockImplementation(() =>
      new Int16Array(1280).fill(123),
    );

    vi.stubGlobal(
      "AudioContext",
      MockAudioContext as unknown as typeof AudioContext,
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      MockAudioWorkletNode as unknown as typeof AudioWorkletNode,
    );

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      voice: {
        getWakeWordState: vi.fn().mockResolvedValue({ enabled: true }),
        onWakeWordState: vi.fn(() => () => undefined),
        pushWakeWordAudio: vi.fn(),
      },
    };
  });

  it("captures shared microphone audio and forwards wake-word PCM chunks", async () => {
    render(<WakeWordCaptureRoot />);

    await waitFor(() => {
      expect(mockAcquireSharedMicrophone).toHaveBeenCalledTimes(1);
      expect(lastWorkletNode).not.toBeNull();
    });

    await act(async () => {
      lastWorkletNode?.port.onmessage?.({
        data: new Float32Array(1280).fill(0.5),
      } as MessageEvent<Float32Array>);
    });

    expect(mockResampleLinear).toHaveBeenCalled();
    expect(mockFloatToInt16Pcm).toHaveBeenCalled();
    expect(mockBufferRecentVoiceHandoffPcm).toHaveBeenCalledTimes(1);
    expect(
      (
        window as unknown as {
          electronAPI: {
            voice: { pushWakeWordAudio: ReturnType<typeof vi.fn> };
          };
        }
      ).electronAPI.voice.pushWakeWordAudio,
    ).toHaveBeenCalledTimes(1);
  });

  it("stays idle while voice is active", async () => {
    mockUseUiState.mockReturnValue({
      state: {
        mode: "voice",
        window: "overlay",
        view: "home",
        conversationId: "conv-1",
        isVoiceActive: false,
        isVoiceRtcActive: true,
      },
    });
    (
      window as unknown as {
        electronAPI: { voice: { getWakeWordState: ReturnType<typeof vi.fn> } };
      }
    ).electronAPI.voice.getWakeWordState.mockResolvedValue({ enabled: false });

    render(<WakeWordCaptureRoot />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockAcquireSharedMicrophone).not.toHaveBeenCalled();
  });
});


