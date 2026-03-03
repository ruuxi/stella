import { describe, test, expect } from "bun:test";
import { BROWSER_AGENT_SYSTEM_PROMPT } from "../convex/prompts/browser";

describe("BROWSER_AGENT_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof BROWSER_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(BROWSER_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(200);
  });

  test("identifies as Browser Agent", () => {
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain("Browser Agent");
  });

  test("mentions session management", () => {
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain("session");
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain("stella-browser");
  });

  test("includes timeout guidance", () => {
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain("Timeout");
    expect(BROWSER_AGENT_SYSTEM_PROMPT).toContain("milliseconds");
  });
});
