import { describe, test, expect } from "bun:test";
import {
  buildSkillMetadataUserMessage,
} from "../convex/prompts/skill_metadata";

describe("buildSkillMetadataUserMessage", () => {
  test("includes directory name", () => {
    const result = buildSkillMetadataUserMessage(
      "code-review",
      "# Code Review\nReview code...",
      "Directory name and skill content are provided below.",
    );
    expect(result).toContain("code-review");
  });

  test("includes markdown content", () => {
    const result = buildSkillMetadataUserMessage(
      "test-skill",
      "# Test\nContent here",
      "Directory name and skill content are provided below.",
    );
    expect(result).toContain("Content here");
  });

  test("truncates long markdown", () => {
    const longContent = "x".repeat(5000);
    const result = buildSkillMetadataUserMessage(
      "big-skill",
      longContent,
      "Directory name and skill content are provided below.",
    );
    expect(result.length).toBeLessThan(5500);
    expect(result).toContain("...");
  });

  test("does not truncate short markdown", () => {
    const shortContent = "Short skill content";
    const result = buildSkillMetadataUserMessage(
      "small-skill",
      shortContent,
      "Directory name and skill content are provided below.",
    );
    expect(result).toContain(shortContent);
    expect(result).not.toContain("...");
  });
});
