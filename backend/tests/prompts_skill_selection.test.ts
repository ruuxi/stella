import { describe, test, expect } from "bun:test";
import {
  SKILL_SELECTION_PROMPT,
  buildSkillSelectionUserMessage,
} from "../convex/prompts/skill_selection";

describe("SKILL_SELECTION_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof SKILL_SELECTION_PROMPT).toBe("string");
    expect(SKILL_SELECTION_PROMPT.length).toBeGreaterThan(50);
  });

  test("requests JSON array output", () => {
    expect(SKILL_SELECTION_PROMPT).toContain("JSON array");
  });

  test("defines selection criteria", () => {
    expect(SKILL_SELECTION_PROMPT).toContain("Selection criteria");
    expect(SKILL_SELECTION_PROMPT).toContain("Developers");
  });

  test("recommends skill count range", () => {
    expect(SKILL_SELECTION_PROMPT).toContain("6-10");
  });
});

describe("buildSkillSelectionUserMessage", () => {
  const catalog = [
    { id: "docx", name: "Document Creator", description: "Creates documents" },
    { id: "code-review", name: "Code Review", description: "Reviews code", tags: ["dev", "quality"] },
  ];

  test("includes user profile in output", () => {
    const result = buildSkillSelectionUserMessage("User is a developer", catalog);
    expect(result).toContain("User is a developer");
  });

  test("includes all catalog entries", () => {
    const result = buildSkillSelectionUserMessage("profile", catalog);
    expect(result).toContain("docx");
    expect(result).toContain("Document Creator");
    expect(result).toContain("code-review");
  });

  test("includes tags when present", () => {
    const result = buildSkillSelectionUserMessage("profile", catalog);
    expect(result).toContain("dev, quality");
  });

  test("handles empty catalog", () => {
    const result = buildSkillSelectionUserMessage("profile", []);
    expect(result).toContain("User profile");
  });
});
