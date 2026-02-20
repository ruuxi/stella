import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "./speech-to-text";
import { getOrCreateDeviceId } from "./device";

vi.mock("./device", () => ({
  getOrCreateDeviceId: vi.fn(),
}));

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
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
          id: "tx-1",
          text: "hello world",
          detectedLanguage: "en",
          totalTime: 123,
          generatedTokens: 7,
        }),
        { status: 200 },
      ),
    );

    const result = await transcribeAudio({
      audio: new Blob(["hello"], { type: "audio/wav" }),
      language: ["en"],
      context: { app: { type: "ai" } },
    });

    expect(result).toEqual({
      id: "tx-1",
      text: "hello world",
      detectedLanguage: "en",
      totalTime: 123,
      generatedTokens: 7,
    });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [endpoint, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(endpoint)).toContain("/api/speech-to-text");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-Device-ID": "device-123",
      }),
    });

    const body = JSON.parse(String(init?.body));
    expect(typeof body.audio).toBe("string");
    expect(body.audio.length).toBeGreaterThan(0);
    expect(body.language).toEqual(["en"]);
    expect(body.context).toEqual({ app: { type: "ai" } });
  });

  it("throws on non-ok response with response body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("Speech-to-text failed: 400 - bad request");
  });

  it("throws when response is missing text", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "tx-2" }), { status: 200 }),
    );

    await expect(
      transcribeAudio({ audio: new Blob(["hello"], { type: "audio/wav" }) }),
    ).rejects.toThrow("Speech-to-text response missing text");
  });
});
