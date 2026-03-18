import { describe, test, expect } from "bun:test";
import { buildVoiceSessionInstructions } from "../convex/prompts/voice_orchestrator";

describe("buildVoiceSessionInstructions base prompt handling", () => {
  test("uses the provided base prompt", () => {
    const prompt = "You are Stella in voice mode. Stella is pronounced STEH-luh.";
    const result = buildVoiceSessionInstructions({ basePrompt: prompt });
    expect(result).toContain("Stella");
    expect(result).toContain("voice mode");
    expect(result).toContain("STEH-luh");
  });
});
