import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../../../../../src/features/voice/services/speech-to-text";
import { getOrCreateDeviceId } from "@/platform/electron/device";

vi.mock("@/platform/electron/device", () => ({
  getOrCreateDeviceId: vi.fn(),
}));

vi.mock("@/features/voice/services/audio-encoding", () => ({
  TARGET_PCM_SAMPLE_RATE: 24_000,
  decodeAudioBlobToMonoSamples: vi.fn(async () => ({
    samples: new Float32Array([0.1, -0.1, 0.2, -0.2]),
    sampleRate: 24_000,
  })),
  encodeInt16ToBase64: vi.fn(() => "encoded-audio"),
  floatToInt16Pcm: vi.fn(() => new Int16Array([1, -1, 2, -2])),
  resampleLinear: vi.fn((samples: Float32Array) => samples),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static reset() {
    MockWebSocket.instances = [];
  }

  readonly url: string;
  readonly protocols: string[];
  readonly sentMessages: string[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = 1;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = Array.isArray(protocols)
      ? protocols
      : protocols
        ? [protocols]
        : [];
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sentMessages.push(String(data));
  }

  close(): void {}

  triggerOpen(): void {
    this.onopen?.(new Event("open"));
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  triggerClose(): void {
    this.onclose?.(new Event("close") as CloseEvent);
  }
}

describe("transcribeAudio", () => {
  const waitForSocket = async (): Promise<MockWebSocket> => {
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });
    return MockWebSocket.instances[0]!;
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    MockWebSocket.reset();
    vi.mocked(getOrCreateDeviceId).mockResolvedValue("device-123");
    import.meta.env.VITE_CONVEX_URL = "https://test.convex.cloud";
    import.meta.env.VITE_CONVEX_HTTP_URL = "https://test.convex.site";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when VITE_CONVEX_URL is not set", async () => {
    import.meta.env.VITE_CONVEX_URL = "";

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("VITE_CONVEX_URL is not set");
  });

  it("creates a realtime speech session and streams audio chunks", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          clientSecret: "ek_test_123",
          websocketUrl: "wss://api.openai.com/v1/realtime",
          sessionId: "sess_123",
        }),
        { status: 200 },
      ))
    );

    const transcriptionPromise = transcribeAudio({
      audio: new Blob(["hello"], { type: "audio/wav" }),
      language: ["en"],
      properties: { prompt: "Product names are important." },
    });

    const socket = await waitForSocket();
    expect(socket.url).toBe("wss://api.openai.com/v1/realtime");
    expect(socket.protocols).toEqual([
      "realtime",
      "openai-insecure-api-key.ek_test_123",
    ]);

    socket.triggerOpen();

    expect(socket.sentMessages).toHaveLength(1);
    const sessionUpdate = JSON.parse(socket.sentMessages[0]!);
    expect(sessionUpdate).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24_000,
            },
            noise_reduction: {
              type: "near_field",
            },
            transcription: {
              model: "gpt-4o-transcribe",
              language: "en",
              prompt: "Product names are important.",
            },
            turn_detection: null,
          },
        },
      },
    });

    socket.triggerMessage({ type: "session.updated" });

    await vi.waitFor(() => {
      expect(socket.sentMessages.length).toBeGreaterThanOrEqual(3);
    });

    const appendMessage = JSON.parse(socket.sentMessages[1]!);
    const commitMessage = JSON.parse(socket.sentMessages.at(-1)!);

    expect(appendMessage.type).toBe("input_audio_buffer.append");
    expect(typeof appendMessage.audio).toBe("string");
    expect(appendMessage.audio.length).toBeGreaterThan(0);

    expect(commitMessage).toEqual({
      type: "input_audio_buffer.commit",
    });

    socket.triggerMessage({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_123",
      transcript: "hello world",
    });

    const result = await transcriptionPromise;

    expect(result).toEqual({
      id: "item_123",
      text: "hello world",
      detectedLanguage: null,
      totalTime: null,
      generatedTokens: null,
    });

    const sessionCall = vi.mocked(fetch).mock.calls.find(
      ([url]) => String(url).includes("/api/speech-to-text/session"),
    );
    expect(sessionCall).toBeDefined();
    const [endpoint, init] = sessionCall!;
    expect(String(endpoint)).toContain("/api/speech-to-text/session");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-Device-ID": "device-123",
      }),
    });
  });

  it("throws on non-ok session response with response body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("Speech session failed: 401 - Unauthorized");
  });

  it("throws when session response is missing websocket config", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ clientSecret: "ek_only" }), { status: 200 }),
    );

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("Speech session response missing websocketUrl");
  });

  it("throws when websocket closes before text is received", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          clientSecret: "ek_test_123",
          websocketUrl: "wss://api.openai.com/v1/realtime",
          sessionId: "sess_123",
        }),
        { status: 200 },
      ),
    );

    const transcriptionPromise = transcribeAudio({
      audio: new Blob(["hello"], { type: "audio/wav" }),
    });

    const socket = await waitForSocket();
    socket.triggerOpen();
    socket.triggerMessage({ type: "session.updated" });
    await vi.waitFor(() => {
      expect(socket.sentMessages.length).toBeGreaterThanOrEqual(3);
    });
    socket.triggerClose();

    await expect(transcriptionPromise).rejects.toThrow(
      "Speech websocket closed before receiving transcription text",
    );
  });
});
