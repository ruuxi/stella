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
  acquireSharedMicrophone: () => mockAcquireSharedMicrophone(),
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

let lastPeerConnection: MockPeerConnection | null = null;

import { RealtimeVoiceSession } from "../../../../../src/features/voice/services/realtime-voice";

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("connects a warm rtc session without eagerly acquiring the microphone", async () => {
    const session = new RealtimeVoiceSession();

    await session.connect("convone");

    expect(session.state).toBe("connected");
    expect(mockAcquireSharedMicrophone).not.toHaveBeenCalled();
    expect(lastPeerConnection?.sender.replaceTrack).not.toHaveBeenCalled();

    await session.disconnect();
  });
});
