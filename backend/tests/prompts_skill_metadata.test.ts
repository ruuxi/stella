import { describe, test, expect } from "bun:test";
import {
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
} from "../convex/prompts/skill_metadata";

describe("SKILL_METADATA_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof SKILL_METADATA_PROMPT).toBe("string");
    expect(SKILL_METADATA_PROMPT.length).toBeGreaterThan(50);
  });

  test("requests JSON output", () => {
    expect(SKILL_METADATA_PROMPT).toContain("JSON");
  });

  test("defines expected fields", () => {
    expect(SKILL_METADATA_PROMPT).toContain("id");
    expect(SKILL_METADATA_PROMPT).toContain("name");
    expect(SKILL_METADATA_PROMPT).toContain("description");
    expect(SKILL_METADATA_PROMPT).toContain("agentTypes");
  });
});

describe("buildSkillMetadataUserMessage", () => {
  test("includes directory name", () => {
    const result = buildSkillMetadataUserMessage("code-review", "# Code Review\nReview code...");
    expect(result).toContain("code-review");
  });

  test("includes markdown content", () => {
    const result = buildSkillMetadataUserMessage("test-skill", "# Test\nContent here");
    expect(result).toContain("Content here");
  });

  test("truncates long markdown", () => {
    const longContent = "x".repeat(5000);
    const result = buildSkillMetadataUserMessage("big-skill", longContent);
    expect(result.length).toBeLessThan(5500);
    expect(result).toContain("...");
  });

  test("does not truncate short markdown", () => {
    const shortContent = "Short skill content";
    const result = buildSkillMetadataUserMessage("small-skill", shortContent);
    expect(result).toContain(shortContent);
    expect(result).not.toContain("...");
  });
});
