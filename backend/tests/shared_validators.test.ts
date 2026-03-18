import { describe, test, expect } from "bun:test";
import { requireBoundedString } from "../convex/shared_validators";

describe("requireBoundedString", () => {
  test("passes for strings within limit", () => {
    expect(() => requireBoundedString("hello", "name", 10)).not.toThrow();
    expect(() => requireBoundedString("", "name", 10)).not.toThrow();
  });

  test("passes for strings at exact limit", () => {
    expect(() => requireBoundedString("12345", "name", 5)).not.toThrow();
  });

  test("throws for strings exceeding limit", () => {
    expect(() => requireBoundedString("123456", "name", 5)).toThrow();
  });

  test("includes field name in error", () => {
    try {
      requireBoundedString("too long", "username", 3);
      expect(true).toBe(false); // should not reach
    } catch (error: any) {
      expect(error.data?.message ?? error.message).toContain("username");
    }
  });

  test("includes max length in error", () => {
    try {
      requireBoundedString("too long", "field", 3);
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.data?.message ?? error.message).toContain("3");
    }
  });
});
