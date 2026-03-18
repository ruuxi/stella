import { describe, test, expect } from "bun:test";
import {
  sanitizeSensitiveData,
  sanitizeForLogs,
  REDACTED_VALUE,
} from "../convex/lib/redaction";

describe("sanitizeSensitiveData", () => {
  test("redacts sensitive keys", () => {
    const input = { authorization: "Bearer secret123", data: "safe" };
    const result = sanitizeSensitiveData(input) as Record<string, unknown>;
    expect(result.authorization).toBe(REDACTED_VALUE);
    expect(result.data).toBe("safe");
  });

  test("redacts api_key fields", () => {
    const result = sanitizeSensitiveData({ api_key: "sk-123" }) as Record<string, unknown>;
    expect(result.api_key).toBe(REDACTED_VALUE);
  });

  test("redacts password fields", () => {
    const result = sanitizeSensitiveData({ password: "secret" }) as Record<string, unknown>;
    expect(result.password).toBe(REDACTED_VALUE);
  });

  test("redacts bearer tokens in strings", () => {
    const result = sanitizeSensitiveData("Bearer eyJtoken123.payload.sig") as string;
    expect(result).not.toContain("eyJtoken123");
    expect(result).toContain(REDACTED_VALUE);
  });

  test("redacts JWT tokens in strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123abc";
    const result = sanitizeSensitiveData(jwt) as string;
    expect(result).toBe(REDACTED_VALUE);
  });

  test("handles nested objects", () => {
    const input = { outer: { token: "secret", safe: "value" } };
    const result = sanitizeSensitiveData(input) as Record<string, Record<string, unknown>>;
    expect(result.outer.token).toBe(REDACTED_VALUE);
    expect(result.outer.safe).toBe("value");
  });

  test("handles arrays", () => {
    const result = sanitizeSensitiveData([1, "hello", { token: "s" }]) as unknown[];
    expect(result).toHaveLength(3);
  });

  test("handles null and primitives", () => {
    expect(sanitizeSensitiveData(null)).toBeNull();
    expect(sanitizeSensitiveData(42)).toBe(42);
    expect(sanitizeSensitiveData(true)).toBe(true);
  });

  test("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => sanitizeSensitiveData(obj)).not.toThrow();
  });

  test("truncates deeply nested structures", () => {
    let obj: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    const result = sanitizeSensitiveData(obj);
    expect(JSON.stringify(result)).toContain("[TRUNCATED]");
  });
});

describe("sanitizeForLogs", () => {
  test("redacts freeform strings", () => {
    const result = sanitizeForLogs("Bearer token123abc") as string;
    expect(result).toContain(REDACTED_VALUE);
  });
});
