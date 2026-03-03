import { describe, test, expect } from "bun:test";
import {
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
  CORE_MEMORY_SYNTHESIS_PROMPT,
} from "../convex/prompts/synthesis";

describe("CORE_MEMORY_SYNTHESIS_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof CORE_MEMORY_SYNTHESIS_PROMPT).toBe("string");
    expect(CORE_MEMORY_SYNTHESIS_PROMPT.length).toBeGreaterThan(100);
  });

  test("contains required sections", () => {
    expect(CORE_MEMORY_SYNTHESIS_PROMPT).toContain("[who]");
    expect(CORE_MEMORY_SYNTHESIS_PROMPT).toContain("[projects]");
    expect(CORE_MEMORY_SYNTHESIS_PROMPT).toContain("[apps]");
    expect(CORE_MEMORY_SYNTHESIS_PROMPT).toContain("[environment]");
  });
});

describe("buildCoreSynthesisUserMessage", () => {
  test("includes raw outputs in message", () => {
    const result = buildCoreSynthesisUserMessage("signal data here");
    expect(result).toContain("signal data here");
  });

  test("contains synthesis instruction", () => {
    const result = buildCoreSynthesisUserMessage("data");
    expect(result).toContain("Synthesize");
    expect(result).toContain("CORE MEMORY");
  });
});

describe("buildWelcomeMessagePrompt", () => {
  test("includes core memory in prompt", () => {
    const result = buildWelcomeMessagePrompt("User is a developer");
    expect(result).toContain("User is a developer");
  });

  test("mentions Stella", () => {
    const result = buildWelcomeMessagePrompt("profile");
    expect(result).toContain("Stella");
  });

  test("includes tone guidance", () => {
    const result = buildWelcomeMessagePrompt("profile");
    expect(result).toContain("TONE");
    expect(result).toContain("AVOID");
  });
});

describe("buildWelcomeSuggestionsPrompt", () => {
  test("includes core memory in prompt", () => {
    const result = buildWelcomeSuggestionsPrompt("User profile data");
    expect(result).toContain("User profile data");
  });

  test("requests JSON array output", () => {
    const result = buildWelcomeSuggestionsPrompt("profile");
    expect(result).toContain("JSON array");
  });

  test("mentions suggestion categories", () => {
    const result = buildWelcomeSuggestionsPrompt("profile");
    expect(result).toContain("cron");
    expect(result).toContain("skill");
    expect(result).toContain("app");
  });
});
