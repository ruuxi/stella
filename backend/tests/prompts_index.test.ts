import { describe, test, expect } from "bun:test";
import {
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
  buildSkillMetadataUserMessage,
  buildSkillSelectionUserMessage,
  buildPersonalizedDashboardPageUserMessage,
  OFFLINE_RESPONDER_SYSTEM_PROMPT,
} from "../convex/prompts/index";

describe("prompts/index re-exports", () => {
  test("exports synthesis-related items", () => {
    expect(typeof buildCoreSynthesisUserMessage).toBe("function");
    expect(typeof buildWelcomeMessagePrompt).toBe("function");
    expect(typeof buildWelcomeSuggestionsPrompt).toBe("function");
  });

  test("exports skill-related items", () => {
    expect(typeof buildSkillMetadataUserMessage).toBe("function");
    expect(typeof buildSkillSelectionUserMessage).toBe("function");
  });

  test("exports dashboard items", () => {
    expect(typeof buildPersonalizedDashboardPageUserMessage).toBe("function");
  });

  test("keeps offline responder prompt on backend", () => {
    expect(typeof OFFLINE_RESPONDER_SYSTEM_PROMPT).toBe("string");
    expect(OFFLINE_RESPONDER_SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });
});
