import { describe, test, expect } from "bun:test";
import { EXPLORE_AGENT_SYSTEM_PROMPT } from "../convex/prompts/explore";

describe("EXPLORE_AGENT_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof EXPLORE_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(300);
  });

  test("identifies as Explore Agent", () => {
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Explore Agent");
  });

  test("defines Mode 1: Codebase Exploration", () => {
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Codebase Exploration");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Glob");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Grep");
  });

  test("defines Mode 2: Web Research", () => {
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Web Research");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("WebSearch");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("WebFetch");
  });

  test("defines thoroughness levels", () => {
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Quick");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Medium");
    expect(EXPLORE_AGENT_SYSTEM_PROMPT).toContain("Thorough");
  });
});
