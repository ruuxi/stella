import { describe, test, expect } from "bun:test";
import { BASE_TOOL_NAMES } from "../convex/tools/types";

describe("BASE_TOOL_NAMES", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(BASE_TOOL_NAMES)).toBe(true);
    expect(BASE_TOOL_NAMES.length).toBeGreaterThan(20);
  });

  test("contains device tools", () => {
    expect(BASE_TOOL_NAMES).toContain("Read");
    expect(BASE_TOOL_NAMES).toContain("Write");
    expect(BASE_TOOL_NAMES).toContain("Edit");
    expect(BASE_TOOL_NAMES).toContain("Glob");
    expect(BASE_TOOL_NAMES).toContain("Grep");
    expect(BASE_TOOL_NAMES).toContain("Bash");
  });

  test("contains backend tools", () => {
    expect(BASE_TOOL_NAMES).toContain("WebSearch");
    expect(BASE_TOOL_NAMES).toContain("WebFetch");
    expect(BASE_TOOL_NAMES).toContain("IntegrationRequest");
  });

  test("contains scheduling tools", () => {
    expect(BASE_TOOL_NAMES).toContain("HeartbeatGet");
    expect(BASE_TOOL_NAMES).toContain("HeartbeatUpsert");
    expect(BASE_TOOL_NAMES).toContain("CronList");
    expect(BASE_TOOL_NAMES).toContain("CronAdd");
  });

  test("contains orchestration tools", () => {
    expect(BASE_TOOL_NAMES).toContain("TaskCreate");
    expect(BASE_TOOL_NAMES).toContain("TaskOutput");
    expect(BASE_TOOL_NAMES).toContain("RecallMemories");
    expect(BASE_TOOL_NAMES).toContain("SaveMemory");
  });

  test("has no duplicates", () => {
    const set = new Set(BASE_TOOL_NAMES);
    expect(set.size).toBe(BASE_TOOL_NAMES.length);
  });
});
