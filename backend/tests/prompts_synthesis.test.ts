import { describe, test, expect } from "bun:test";
import {
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
} from "../convex/prompts/synthesis";

describe("buildCoreSynthesisUserMessage", () => {
  test("includes raw outputs in message", () => {
    const result = buildCoreSynthesisUserMessage("signal data here", "Synthesize this.");
    expect(result).toContain("signal data here");
  });

  test("contains synthesis instruction", () => {
    const result = buildCoreSynthesisUserMessage("data", "Synthesize this into CORE MEMORY.");
    expect(result).toContain("Synthesize");
    expect(result).toContain("CORE MEMORY");
  });
});

describe("buildWelcomeMessagePrompt", () => {
  test("includes core memory in prompt", () => {
    const result = buildWelcomeMessagePrompt("User is a developer", "Write Stella's welcome.");
    expect(result).toContain("User is a developer");
  });

  test("mentions Stella", () => {
    const result = buildWelcomeMessagePrompt("profile", "Write Stella's welcome.");
    expect(result).toContain("Stella");
  });
});

describe("buildWelcomeSuggestionsPrompt", () => {
  test("includes core memory in prompt", () => {
    const result = buildWelcomeSuggestionsPrompt("User profile data", "Return a JSON array.");
    expect(result).toContain("User profile data");
  });

  test("requests JSON array output", () => {
    const result = buildWelcomeSuggestionsPrompt("profile", "Return a JSON array.");
    expect(result).toContain("JSON array");
  });

  test("mentions suggestion categories", () => {
    const result = buildWelcomeSuggestionsPrompt(
      "profile",
      'Use categories "cron", "skill", and "app".',
    );
    expect(result).toContain("cron");
    expect(result).toContain("skill");
    expect(result).toContain("app");
  });
});
