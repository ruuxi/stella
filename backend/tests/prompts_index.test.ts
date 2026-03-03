import { describe, test, expect } from "bun:test";
import {
  ORCHESTRATOR_AGENT_SYSTEM_PROMPT,
  GENERAL_AGENT_SYSTEM_PROMPT,
  EXPLORE_AGENT_SYSTEM_PROMPT,
  BROWSER_AGENT_SYSTEM_PROMPT,
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
  test("exports all agent system prompts", () => {
    expect(typeof ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(typeof GENERAL_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(typeof EXPLORE_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(typeof BROWSER_AGENT_SYSTEM_PROMPT).toBe("string");
  });

  test("exports synthesis prompts", () => {
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
