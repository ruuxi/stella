import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { synthesizeCoreMemory } from "./synthesis";

describe("synthesizeCoreMemory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    import.meta.env.VITE_CONVEX_URL = "https://test.convex.cloud";
    import.meta.env.VITE_CONVEX_HTTP_URL = "https://test.convex.site";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when VITE_CONVEX_URL is not set", async () => {
    import.meta.env.VITE_CONVEX_URL = "";
    await expect(synthesizeCoreMemory("signals")).rejects.toThrow("VITE_CONVEX_URL is not set");
  });

  it("returns synthesis result on success", async () => {
    const mockResult = {
      coreMemory: "core memory content",
      welcomeMessage: "welcome!",
      suggestions: [{ category: "skill", title: "Test", description: "Desc", prompt: "prompt" }],
    };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 200 })
    );

    const result = await synthesizeCoreMemory("test signals");
    expect(result).toEqual(mockResult);
  });

  it("throws on non-ok response with error text", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("bad request", { status: 400, statusText: "Bad Request" })
    );

    await expect(synthesizeCoreMemory("bad")).rejects.toThrow(
      "Synthesis failed: 400 - bad request"
    );
  });

  it("sends formattedSignals in request body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ coreMemory: "", welcomeMessage: "" }), { status: 200 })
    );

    await synthesizeCoreMemory("my signals data");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/api/synthesize"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ formattedSignals: "my signals data" }),
      })
    );
  });

  it("constructs URL using VITE_CONVEX_HTTP_URL when available", async () => {
    import.meta.env.VITE_CONVEX_HTTP_URL = "https://custom.site.example";
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ coreMemory: "", welcomeMessage: "" }), { status: 200 })
    );

    await synthesizeCoreMemory("signals");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/api/synthesize"),
      expect.any(Object)
    );
  });
});
