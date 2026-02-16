import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { selectDefaultSkills } from "./skill-selection";

describe("selectDefaultSkills", () => {
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
    await expect(selectDefaultSkills("memory")).rejects.toThrow(
      "VITE_CONVEX_URL is not set"
    );
  });

  it("returns skill selection result on success", async () => {
    const mockResult = { selectedSkillIds: ["skill-1", "skill-2"] };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(mockResult), { status: 200 })
    );

    const result = await selectDefaultSkills("core memory");
    expect(result).toEqual(mockResult);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("server error", { status: 500, statusText: "Internal Server Error" })
    );

    await expect(selectDefaultSkills("memory")).rejects.toThrow(
      "Skill selection failed: 500 - server error"
    );
  });

  it("sends coreMemory in request body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ selectedSkillIds: [] }), { status: 200 })
    );

    await selectDefaultSkills("test memory data");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/api/select-default-skills"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ coreMemory: "test memory data" }),
      })
    );
  });
});
