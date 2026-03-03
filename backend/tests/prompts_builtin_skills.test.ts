import { describe, test, expect } from "bun:test";
import { BUILTIN_SKILLS } from "../convex/prompts/builtin_skills";

describe("BUILTIN_SKILLS", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(BUILTIN_SKILLS)).toBe(true);
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
  });

  test("each skill has required fields", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(typeof skill.id).toBe("string");
      expect(skill.id.length).toBeGreaterThan(0);
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(typeof skill.markdown).toBe("string");
      expect(Array.isArray(skill.agentTypes)).toBe(true);
      expect(Array.isArray(skill.tags)).toBe(true);
      expect(skill.source).toBe("builtin");
      expect(skill.enabled).toBe(true);
    }
  });

  test("skill IDs are unique", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("includes scheduling skill", () => {
    const scheduling = BUILTIN_SKILLS.find((s) => s.id === "scheduling");
    expect(scheduling).toBeDefined();
    expect(scheduling!.agentTypes).toContain("orchestrator");
  });

  test("each skill has non-empty markdown", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.markdown.length).toBeGreaterThan(50);
    }
  });
});
