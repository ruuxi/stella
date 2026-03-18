import { describe, test, expect } from "bun:test";
import { coerceStringArray } from "../convex/lib/coerce";

describe("coerceStringArray", () => {
  test("returns empty array for falsy values", () => {
    expect(coerceStringArray(null)).toEqual([]);
    expect(coerceStringArray(undefined)).toEqual([]);
    expect(coerceStringArray("")).toEqual([]);
  });

  test("passes through string arrays with trimming", () => {
    expect(coerceStringArray(["a", " b ", "c"])).toEqual(["a", "b", "c"]);
  });

  test("filters empty entries from arrays", () => {
    expect(coerceStringArray(["a", "", " ", "b"])).toEqual(["a", "b"]);
  });

  test("converts non-string array items", () => {
    expect(coerceStringArray([1, 2, 3])).toEqual(["1", "2", "3"]);
  });

  test("splits comma-separated strings", () => {
    expect(coerceStringArray("a, b, c")).toEqual(["a", "b", "c"]);
  });

  test("wraps single non-string values", () => {
    expect(coerceStringArray(42)).toEqual(["42"]);
  });
});
