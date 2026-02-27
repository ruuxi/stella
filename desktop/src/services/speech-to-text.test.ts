import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "./speech-to-text";
import { getOrCreateDeviceId } from "./device";

vi.mock("./device", () => ({
  getOrCreateDeviceId: vi.fn(),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  readonly url: string;
  readonly sentMessages: string[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
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

  it("calls speech-to-text endpoint with audio and device id", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          clientKey: "client-key-123",
          websocketUrl: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
        }),
        { status: 200 },
      ),
    );

    const transcriptionPromise = transcribeAudio({
      audio: new Blob(["hello"], { type: "audio/wav" }),
      language: ["en"],
      context: { app: { type: "ai" } },
    });

    const socket = await waitForSocket();
    expect(socket.url).toContain("/api/v1/dash/client_ws?");
    expect(socket.url).toContain("client_key=Bearer+client-key-123");

    socket.triggerOpen();

    expect(socket.sentMessages).toHaveLength(1);
    const authMessage = JSON.parse(socket.sentMessages[0]!);
    expect(authMessage).toEqual({
      type: "auth",
      access_token: "client-key-123",
      language: ["en"],
      context: { app: { type: "ai" } },
    });

    socket.triggerMessage({ status: "auth" });

    expect(socket.sentMessages).toHaveLength(3);
    const appendMessage = JSON.parse(socket.sentMessages[1]!);
    const commitMessage = JSON.parse(socket.sentMessages[2]!);

    expect(appendMessage.type).toBe("append");
    expect(appendMessage.position).toBe(0);
    expect(Array.isArray(appendMessage.audio_packets?.packets)).toBe(true);
    expect(Array.isArray(appendMessage.audio_packets?.volumes)).toBe(true);
    expect(appendMessage.audio_packets?.packets?.length).toBeGreaterThan(0);
    expect(appendMessage.audio_packets?.packets?.length).toBe(
      appendMessage.audio_packets?.volumes?.length,
    );
    expect(appendMessage.audio_packets?.audio_encoding).toBe("wav");
    expect(appendMessage.audio_packets?.byte_encoding).toBe("base64");
    expect(typeof appendMessage.audio_packets?.packet_duration).toBe("number");

    expect(commitMessage).toEqual({
      type: "commit",
      total_packets: appendMessage.audio_packets.packets.length,
    });

    socket.triggerMessage({
      status: "text",
      final: false,
      body: {
        text: "hello",
        detected_language: "en",
      },
    });

    socket.triggerMessage({
      status: "text",
      final: true,
      body: {
        text: "hello world",
        detected_language: "en",
      },
    });

    const result = await transcriptionPromise;

    expect(result).toEqual({
      id: null,
      text: "hello world",
      detectedLanguage: "en",
      totalTime: null,
      generatedTokens: null,
    });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [endpoint, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(endpoint)).toContain("/api/speech-to-text/ws-token");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-Device-ID": "device-123",
      }),
    });
  });

  it("throws on non-ok token response with response body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("Speech websocket token failed: 401 - Unauthorized");
  });

  it("throws when token response is missing websocket config", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ clientKey: "token-only" }), { status: 200 }),
    );

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("Speech websocket token response missing websocketUrl");
  });

  it("throws when websocket closes before text is received", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          clientKey: "client-key-123",
          websocketUrl: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
        }),
        { status: 200 },
      ),
    );

    const transcriptionPromise = transcribeAudio({
      audio: new Blob(["hello"], { type: "audio/wav" }),
    });

    const socket = await waitForSocket();
    socket.triggerOpen();
    socket.triggerMessage({ status: "auth" });
    socket.triggerClose();

    await expect(transcriptionPromise).rejects.toThrow(
      "Speech websocket closed before receiving transcription text",
    );
  });
});
