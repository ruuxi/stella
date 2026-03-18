import { describe, test, expect } from "bun:test";
import {
  stableStringify,
  parseJsonObject,
  asNonEmptyString,
  withoutTrailingSlash,
  extractJsonBlock,
} from "../convex/lib/json";

describe("stableStringify", () => {
  test("sorts object keys deterministically", () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  test("handles primitives", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(true)).toBe("true");
  });

  test("handles arrays", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("handles nested objects with sorted keys", () => {
    const result = stableStringify({ b: { z: 1, a: 2 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  test("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => stableStringify(obj)).not.toThrow();
    expect(stableStringify(obj)).toContain("[Circular]");
  });
});

describe("parseJsonObject", () => {
  test("parses valid JSON objects", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns null for arrays", () => {
    expect(parseJsonObject("[1,2,3]")).toBeNull();
  });

  test("returns null for primitives", () => {
    expect(parseJsonObject('"hello"')).toBeNull();
    expect(parseJsonObject("42")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseJsonObject("not json")).toBeNull();
    expect(parseJsonObject("")).toBeNull();
  });
});

describe("asNonEmptyString", () => {
  test("returns trimmed string for valid input", () => {
    expect(asNonEmptyString("  hello  ")).toBe("hello");
  });

  test("returns null for empty/whitespace strings", () => {
    expect(asNonEmptyString("")).toBeNull();
    expect(asNonEmptyString("   ")).toBeNull();
  });

  test("returns null for non-string values", () => {
    expect(asNonEmptyString(null)).toBeNull();
    expect(asNonEmptyString(undefined)).toBeNull();
    expect(asNonEmptyString(42)).toBeNull();
  });
});

describe("withoutTrailingSlash", () => {
  test("removes trailing slashes", () => {
    expect(withoutTrailingSlash("https://api.example.com/")).toBe("https://api.example.com");
    expect(withoutTrailingSlash("https://api.example.com///")).toBe("https://api.example.com");
  });

  test("leaves URLs without trailing slash unchanged", () => {
    expect(withoutTrailingSlash("https://api.example.com")).toBe("https://api.example.com");
  });
});

describe("extractJsonBlock", () => {
  test("extracts JSON from surrounding text", () => {
    const text = 'Here is the result: {"key": "value"} and more text';
    expect(extractJsonBlock(text)).toBe('{"key": "value"}');
  });

  test("returns valid JSON as-is", () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
  });

  test("returns null for non-JSON text", () => {
    expect(extractJsonBlock("just plain text")).toBeNull();
    expect(extractJsonBlock("")).toBeNull();
  });

  test("handles arrays in text", () => {
    const text = "Result: [1, 2, 3] done";
    expect(extractJsonBlock(text)).toBe("[1, 2, 3]");
  });
});
