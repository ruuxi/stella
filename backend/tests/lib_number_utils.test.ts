import { describe, test, expect } from "bun:test";
import { clampIntToRange, normalizeOptionalInt } from "../convex/lib/number_utils";

describe("clampIntToRange", () => {
  test("clamps value within range", () => {
    expect(clampIntToRange(5, 1, 10)).toBe(5);
  });

  test("clamps below minimum", () => {
    expect(clampIntToRange(-5, 0, 100)).toBe(0);
  });

  test("clamps above maximum", () => {
    expect(clampIntToRange(200, 0, 100)).toBe(100);
  });

  test("floors fractional values", () => {
    expect(clampIntToRange(5.9, 0, 10)).toBe(5);
  });

  test("handles Infinity", () => {
    expect(clampIntToRange(Infinity, 0, 100)).toBe(0);
  });

  test("handles NaN", () => {
    expect(clampIntToRange(NaN, 0, 100)).toBe(0);
  });

  test("handles swapped min/max", () => {
    expect(clampIntToRange(50, 100, 0)).toBe(50);
  });
});

describe("normalizeOptionalInt", () => {
  test("returns clamped value when provided", () => {
    expect(normalizeOptionalInt({ value: 5, defaultValue: 10, min: 0, max: 100 })).toBe(5);
  });

  test("uses default when value is null", () => {
    expect(normalizeOptionalInt({ value: null, defaultValue: 10, min: 0, max: 100 })).toBe(10);
  });

  test("uses default when value is undefined", () => {
    expect(normalizeOptionalInt({ value: undefined, defaultValue: 10, min: 0, max: 100 })).toBe(10);
  });

  test("clamps the result", () => {
    expect(normalizeOptionalInt({ value: 200, defaultValue: 10, min: 0, max: 100 })).toBe(100);
  });
});
