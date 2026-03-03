import { describe, test, expect } from "bun:test";
import { hashString } from "../convex/lib/string_hash";

describe("hashString", () => {
  test("returns consistent hashes", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
  });

  test("returns different hashes for different inputs", () => {
    expect(hashString("hello")).not.toBe(hashString("world"));
  });

  test("returns 8-character hex string", () => {
    const hash = hashString("test");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("handles empty string", () => {
    const hash = hashString("");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
