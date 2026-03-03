import { describe, test, expect } from "bun:test";
import { VOICE_ORCHESTRATOR_PROMPT } from "../convex/prompts/voice_orchestrator";

describe("VOICE_ORCHESTRATOR_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof VOICE_ORCHESTRATOR_PROMPT).toBe("string");
    expect(VOICE_ORCHESTRATOR_PROMPT.length).toBeGreaterThan(200);
  });

  test("identifies as Stella in voice mode", () => {
    expect(VOICE_ORCHESTRATOR_PROMPT).toContain("Stella");
    expect(VOICE_ORCHESTRATOR_PROMPT).toContain("voice mode");
  });

  test("includes personality guidance", () => {
    expect(VOICE_ORCHESTRATOR_PROMPT).toContain("Personality");
    expect(VOICE_ORCHESTRATOR_PROMPT).toContain("warm");
  });

  test("specifies pronunciation", () => {
    expect(VOICE_ORCHESTRATOR_PROMPT).toContain("STEH-luh");
  });
});
