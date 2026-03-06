import { describe, test, expect } from "bun:test";
import { BASE_TOOL_NAMES } from "../convex/tools/types";

describe("BASE_TOOL_NAMES", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(BASE_TOOL_NAMES)).toBe(true);
    expect(BASE_TOOL_NAMES.length).toBeGreaterThan(8);
  });

  test("contains web tools", () => {
    expect(BASE_TOOL_NAMES).toContain("WebSearch");
    expect(BASE_TOOL_NAMES).toContain("WebFetch");
  });

  test("contains scheduling tools", () => {
    expect(BASE_TOOL_NAMES).toContain("HeartbeatGet");
    expect(BASE_TOOL_NAMES).toContain("HeartbeatUpsert");
    expect(BASE_TOOL_NAMES).toContain("CronList");
    expect(BASE_TOOL_NAMES).toContain("CronAdd");
  });

  test("contains NoResponse", () => {
    expect(BASE_TOOL_NAMES).toContain("NoResponse");
  });

  test("has no duplicates", () => {
    const set = new Set(BASE_TOOL_NAMES);
    expect(set.size).toBe(BASE_TOOL_NAMES.length);
  });
});
