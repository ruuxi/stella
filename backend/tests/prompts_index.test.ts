import { describe, test, expect } from "bun:test";
import {
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
  BUILTIN_SKILLS,
  SKILL_SELECTION_PROMPT,
  buildSkillSelectionUserMessage,
  PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  buildPersonalizedDashboardPageUserMessage,
} from "../convex/prompts/index";

describe("prompts/index re-exports", () => {
  test("exports synthesis-related items", () => {
    expect(typeof CORE_MEMORY_SYNTHESIS_PROMPT).toBe("string");
    expect(typeof buildCoreSynthesisUserMessage).toBe("function");
    expect(typeof buildWelcomeMessagePrompt).toBe("function");
    expect(typeof buildWelcomeSuggestionsPrompt).toBe("function");
  });

  test("exports skill-related items", () => {
    expect(typeof SKILL_METADATA_PROMPT).toBe("string");
    expect(typeof buildSkillMetadataUserMessage).toBe("function");
    expect(Array.isArray(BUILTIN_SKILLS)).toBe(true);
    expect(typeof SKILL_SELECTION_PROMPT).toBe("string");
    expect(typeof buildSkillSelectionUserMessage).toBe("function");
  });

  test("exports dashboard items", () => {
    expect(typeof PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toBe("string");
    expect(typeof buildPersonalizedDashboardPageUserMessage).toBe("function");
  });
});
