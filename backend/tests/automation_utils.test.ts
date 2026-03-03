import { describe, test, expect } from "bun:test";
import {
  resolveHeartbeatPrompt,
  isHeartbeatContentEffectivelyEmpty,
  DEFAULT_HEARTBEAT_PROMPT,
} from "../convex/automation/utils";

describe("resolveHeartbeatPrompt", () => {
  test("returns default prompt when no params", () => {
    expect(resolveHeartbeatPrompt({})).toBe(DEFAULT_HEARTBEAT_PROMPT);
  });

  test("uses custom prompt when provided", () => {
    expect(resolveHeartbeatPrompt({ prompt: "Do X" })).toBe("Do X");
  });

  test("falls back to default for empty prompt", () => {
    expect(resolveHeartbeatPrompt({ prompt: "  " })).toBe(DEFAULT_HEARTBEAT_PROMPT);
    expect(resolveHeartbeatPrompt({ prompt: null })).toBe(DEFAULT_HEARTBEAT_PROMPT);
  });

  test("appends checklist to prompt", () => {
    const result = resolveHeartbeatPrompt({ prompt: "Do X", checklist: "- Item 1" });
    expect(result).toContain("Do X");
    expect(result).toContain("Heartbeat checklist:");
    expect(result).toContain("- Item 1");
  });

  test("appends checklist to default prompt when no custom prompt", () => {
    const result = resolveHeartbeatPrompt({ checklist: "- Check emails" });
    expect(result).toContain(DEFAULT_HEARTBEAT_PROMPT);
    expect(result).toContain("- Check emails");
  });

  test("ignores empty checklist", () => {
    expect(resolveHeartbeatPrompt({ checklist: "" })).toBe(DEFAULT_HEARTBEAT_PROMPT);
    expect(resolveHeartbeatPrompt({ checklist: "  " })).toBe(DEFAULT_HEARTBEAT_PROMPT);
    expect(resolveHeartbeatPrompt({ checklist: null })).toBe(DEFAULT_HEARTBEAT_PROMPT);
  });
});

describe("isHeartbeatContentEffectivelyEmpty", () => {
  test("returns false for undefined and null", () => {
    expect(isHeartbeatContentEffectivelyEmpty(undefined)).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty(null)).toBe(false);
  });

  test("returns true for empty string", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
  });

  test("returns true for whitespace only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("   ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("\n\n\n")).toBe(true);
  });

  test("returns true for heading-only content", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Title")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("## Section\n### Subsection")).toBe(true);
  });

  test("returns true for empty list items", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("* ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("- [ ] ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("- [x] ")).toBe(true);
  });

  test("returns true for mixed empty structure", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Title\n\n- \n* \n")).toBe(true);
  });

  test("returns false for content with actual text", () => {
    expect(isHeartbeatContentEffectivelyEmpty("Hello")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("# Title\nSome content")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("- Item with text")).toBe(false);
  });
});
