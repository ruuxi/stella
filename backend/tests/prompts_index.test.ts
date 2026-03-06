import { describe, test, expect } from "bun:test";
import {
  ORCHESTRATOR_AGENT_SYSTEM_PROMPT,
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
  BUILTIN_SKILLS,
  SKILL_SELECTION_PROMPT,
  buildSkillSelectionUserMessage,
  PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  buildPersonalizedDashboardPageUserMessage,
} from "../convex/prompts/index";

describe("prompts/index re-exports", () => {
  test("exports orchestrator system prompt", () => {
    expect(typeof ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toBe("string");
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
