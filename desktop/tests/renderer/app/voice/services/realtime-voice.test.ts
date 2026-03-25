import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateServiceRequest = vi.fn();
const mockGetVoiceSessionPromptConfig = vi.fn();
const mockAcquireSharedMicrophone = vi.fn();

vi.mock("@/infra/http/service-request", () => ({
  createServiceRequest: (...args: unknown[]) => mockCreateServiceRequest(...args),
}));

vi.mock("@/prompts", () => ({
  getVoiceSessionPromptConfig: () => mockGetVoiceSessionPromptConfig(),
}));

vi.mock("@/features/voice/services/shared-microphone", () => ({
  acquireSharedMicrophone: (...args: unknown[]) =>
    mockAcquireSharedMicrophone(...args),
}));

class MockDataChannel {
  readyState: RTCDataChannelState = "open";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

class MockSender {
  replaceTrack = vi.fn(async () => undefined);
}

class MockPeerConnection {
  readonly sender = new MockSender();
  readonly dataChannel = new MockDataChannel();
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  addTransceiver = vi.fn(() => ({
    sender: this.sender,
  }));
  createDataChannel = vi.fn(() => this.dataChannel);
  createOffer = vi.fn(async () => ({ sdp: "offer-sdp" }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  close = vi.fn();
}

class MockAudioContext {
  state: AudioContextState = "running";
  destination = {};
  currentTime = 0;
  close = vi.fn().mockResolvedValue(undefined);
  createAnalyser = vi.fn(() => ({
    frequencyBinCount: 8,
    fftSize: 0,
    getByteFrequencyData: vi.fn((buffer: Uint8Array) => buffer.fill(0)),
  }));
  createGain = vi.fn(() => ({
    gain: {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setTargetAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createMediaStreamDestination = vi.fn(() => ({
    stream: {
      getAudioTracks: () => [{ kind: "audio" }],
    },
  }));
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
}

let lastPeerConnection: MockPeerConnection | null = null;

import {
  RealtimeVoiceSession,
  shouldGateVoiceInputForEcho,
} from "../../../../../src/features/voice/services/realtime-voice";

describe("RealtimeVoiceSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastPeerConnection = null;
    mockCreateServiceRequest.mockResolvedValue({
      endpoint: "https://service.example/api/voice/session",
      headers: {
        Authorization: "Bearer local",
      },
    });
    mockGetVoiceSessionPromptConfig.mockReturnValue({
      basePrompt: "Voice prompt",
    });
    mockAcquireSharedMicrophone.mockResolvedValue({
      stream: {
        getTracks: () => [],
      },
      release: vi.fn(),
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          clientSecret: "secret",
          model: "gpt-4o-realtime-preview",
          voice: "alloy",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "answer-sdp",
      });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        constructor() {
          lastPeerConnection = new MockPeerConnection();
          return lastPeerConnection as unknown as RTCPeerConnection;
        }
      } as unknown as typeof RTCPeerConnection,
    );
    vi.stubGlobal(
      "AudioContext",
      MockAudioContext as unknown as typeof AudioContext,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports realtime usage after response.done", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          clientSecret: "secret",
          model: "gpt-realtime-1.5",
          voice: "alloy",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "answer-sdp",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          recorded: true,
        }),
      });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    mockCreateServiceRequest
      .mockResolvedValueOnce({
        endpoint: "https://service.example/api/voice/session",
        headers: { Authorization: "Bearer local" },
      })
      .mockResolvedValueOnce({
        endpoint: "https://service.example/api/voice/usage",
        headers: { Authorization: "Bearer local" },
      });

    const session = new RealtimeVoiceSession();
    await session.connect("convone");

    lastPeerConnection?.dataChannel.onmessage?.({
      data: JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 123,
            output_tokens: 45,
            total_tokens: 168,
            input_token_details: {
              text_tokens: 23,
              audio_tokens: 100,
            },
            output_token_details: {
              text_tokens: 5,
              audio_tokens: 40,
            },
          },
          output: [],
        },
      }),
    } as MessageEvent<string>);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://service.example/api/voice/usage",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            responseId: "resp_1",
            model: "gpt-realtime-1.5",
            conversationId: "convone",
            usage: {
              input_tokens: 123,
              output_tokens: 45,
              total_tokens: 168,
              input_token_details: {
                text_tokens: 23,
                audio_tokens: 100,
              },
              output_token_details: {
                text_tokens: 5,
                audio_tokens: 40,
              },
            },
          }),
        }),
      );
    });

    await session.disconnect();
  });

  it("connects a warm rtc session without eagerly acquiring the microphone", async () => {
    const session = new RealtimeVoiceSession();

    await session.connect("convone");

    expect(session.state).toBe("connected");
    expect(mockAcquireSharedMicrophone).not.toHaveBeenCalled();
    expect(lastPeerConnection?.sender.replaceTrack).not.toHaveBeenCalled();

    await session.disconnect();
  });

  it("acquires the shared speech-capture mic only while rtc input is active", async () => {
    const track = {
      enabled: false,
      readyState: "live",
      stop: vi.fn(),
    };
    const release = vi.fn();
    mockAcquireSharedMicrophone.mockResolvedValue({
      stream: {
        getTracks: () => [track],
      },
      release,
    });

    const session = new RealtimeVoiceSession();
    await session.connect("convone");

    session.setInputActive(true);

    await waitFor(() => {
      expect(mockAcquireSharedMicrophone).toHaveBeenCalledWith({
        useCase: "voice-rtc",
      });
      expect(lastPeerConnection?.sender.replaceTrack).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "audio" }),
      );
    });

    session.setInputActive(false);

    await waitFor(() => {
      expect(lastPeerConnection?.sender.replaceTrack).toHaveBeenLastCalledWith(
        null,
      );
      expect(track.enabled).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
    });

    await session.disconnect();
  });

  it.each(["goodbye", "close"])(
    "stops rtc input immediately for %s without disconnecting the warm session",
    async (toolName) => {
      const track = {
        enabled: false,
        readyState: "live",
        stop: vi.fn(),
      };
      const release = vi.fn();
      const setUiState = vi.fn();

      mockAcquireSharedMicrophone.mockResolvedValue({
        stream: {
          getTracks: () => [track],
        },
        release,
      });

      (
        window as unknown as {
          electronAPI: {
            ui: { setState: typeof setUiState };
            voice: { persistTranscript: ReturnType<typeof vi.fn> };
          };
        }
      ).electronAPI = {
        ui: {
          setState: setUiState,
        },
        voice: {
          persistTranscript: vi.fn(),
        },
      };

      const session = new RealtimeVoiceSession();
      await session.connect("convone");
      session.setInputActive(true);

      await waitFor(() => {
        expect(lastPeerConnection?.sender.replaceTrack).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "audio" }),
        );
      });

      lastPeerConnection?.dataChannel.onmessage?.({
        data: JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: toolName,
            call_id: "call-1",
            arguments: "{}",
          },
        }),
      } as MessageEvent<string>);

      await waitFor(() => {
        expect(setUiState).toHaveBeenCalledWith({ isVoiceRtcActive: false });
        expect(lastPeerConnection?.sender.replaceTrack).toHaveBeenLastCalledWith(
          null,
        );
        expect(release).toHaveBeenCalledTimes(1);
      });

      expect(session.state).toBe("connected");
      expect(lastPeerConnection?.close).not.toHaveBeenCalled();
      expect(lastPeerConnection?.dataChannel.close).not.toHaveBeenCalled();

      await session.disconnect();
    },
  );

  it("returns an error for unknown function calls", async () => {
    const session = new RealtimeVoiceSession();
    await session.connect("convone");

    lastPeerConnection?.dataChannel.onmessage?.({
      data: JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "mystery_tool",
          call_id: "call-unknown",
          arguments: "{}",
        },
      }),
    } as MessageEvent<string>);

    await waitFor(() => {
      expect(lastPeerConnection?.dataChannel.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: "call-unknown",
            output: "Error: Unknown tool: mystery_tool",
          },
        }),
      );
    });

    await session.disconnect();
  });

  it("injects buffered wake-word follow-up text without triggering a response", async () => {
    const session = new RealtimeVoiceSession();
    await session.connect("convone");

    session.injectWakeWordPrefill("how are you");

    expect(lastPeerConnection?.dataChannel.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "how are you",
            },
          ],
        },
      }),
    );
    expect(lastPeerConnection?.dataChannel.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "response.create" }),
    );

    await session.disconnect();
  });

  it("gates likely speaker echo but still allows real user barge-in", () => {
    expect(
      shouldGateVoiceInputForEcho({
        assistantSpeaking: true,
        micLevel: 0.03,
        outputLevel: 0.12,
      }),
    ).toBe(true);

    expect(
      shouldGateVoiceInputForEcho({
        assistantSpeaking: true,
        micLevel: 0.14,
        outputLevel: 0.12,
      }),
    ).toBe(false);
  });
});
