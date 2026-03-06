import { describe, expect, it, vi } from "vitest";
import { synthesizeCoreMemory } from "./synthesis";

describe("synthesizeCoreMemory", () => {
  it("returns an empty result for blank input", async () => {
    await expect(synthesizeCoreMemory("   \n\n  ")).resolves.toEqual({
      coreMemory: "",
      welcomeMessage: "",
      suggestions: [],
    });
  });

  it("normalizes and caps the local profile document", async () => {
    const source = `\r\n\r\n${"a".repeat(13_000)}\n\n\nextra`;
    const result = await synthesizeCoreMemory(source);

    expect(result.coreMemory).toHaveLength(12_000);
    expect(result.coreMemory.startsWith("a")).toBe(true);
  });

  it("returns local suggestions and a welcome message for non-empty input", async () => {
    const result = await synthesizeCoreMemory("Developer workflow\nTypeScript\nGit");

    expect(result.coreMemory).toBe("Developer workflow\nTypeScript\nGit");
    expect(result.welcomeMessage).toContain("local profile");
    expect(result.suggestions).toHaveLength(3);
  });

  it("does not call fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await synthesizeCoreMemory("signals");

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
