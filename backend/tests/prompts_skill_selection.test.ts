import { describe, test, expect } from "bun:test";
import {
  buildSkillSelectionUserMessage,
} from "../convex/prompts/skill_selection";

describe("buildSkillSelectionUserMessage", () => {
  const catalog = [
    { id: "docx", name: "Document Creator", description: "Creates documents" },
    { id: "code-review", name: "Code Review", description: "Reviews code", tags: ["dev", "quality"] },
  ];

  test("includes user profile in output", () => {
    const result = buildSkillSelectionUserMessage(
      "User is a developer",
      catalog,
      "User profile and available skill catalog are provided below.",
    );
    expect(result).toContain("User is a developer");
  });

  test("includes all catalog entries", () => {
    const result = buildSkillSelectionUserMessage(
      "profile",
      catalog,
      "User profile and available skill catalog are provided below.",
    );
    expect(result).toContain("docx");
    expect(result).toContain("Document Creator");
    expect(result).toContain("code-review");
  });

  test("includes tags when present", () => {
    const result = buildSkillSelectionUserMessage(
      "profile",
      catalog,
      "User profile and available skill catalog are provided below.",
    );
    expect(result).toContain("dev, quality");
  });

  test("handles empty catalog", () => {
    const result = buildSkillSelectionUserMessage(
      "profile",
      [],
      "User profile and available skill catalog are provided below.",
    );
    expect(result).toContain("User profile");
  });
});
