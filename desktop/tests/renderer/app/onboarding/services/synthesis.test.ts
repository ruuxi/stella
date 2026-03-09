import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeCoreMemory } from "../../../../../src/app/onboarding/services/synthesis";
import { createServiceRequest } from "@/infra/http/service-request";

vi.mock("@/infra/http/service-request", () => ({
  createServiceRequest: vi.fn(),
}));

describe("synthesizeCoreMemory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(createServiceRequest).mockResolvedValue({
      endpoint: "https://test.convex.site/api/synthesize",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
        "X-Device-ID": "device-1",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("passes includeAuth through to createServiceRequest", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ coreMemory: "", welcomeMessage: "", suggestions: [] }), { status: 200 })
    );

    await synthesizeCoreMemory("signals", { includeAuth: false });

    expect(createServiceRequest).toHaveBeenCalledWith(
      "/api/synthesize",
      { "Content-Type": "application/json" },
      { includeAuth: false },
    );
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
      new Response(JSON.stringify({ coreMemory: "", welcomeMessage: "", suggestions: [] }), { status: 200 })
    );

    await synthesizeCoreMemory("my signals data");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://test.convex.site/api/synthesize",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "X-Device-ID": "device-1",
        }),
        body: expect.stringContaining('"formattedSignals":"my signals data"'),
      })
    );
  });
});
