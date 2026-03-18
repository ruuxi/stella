import { describe, test, expect } from "bun:test";
import { asObjectRecord, asPlainObjectRecord } from "../convex/lib/object_utils";

describe("asObjectRecord", () => {
  test("returns objects as-is", () => {
    expect(asObjectRecord({ a: 1 })).toEqual({ a: 1 });
  });

  test("returns empty record for non-objects", () => {
    expect(asObjectRecord(null)).toEqual({});
    expect(asObjectRecord(undefined)).toEqual({});
    expect(asObjectRecord(42)).toEqual({});
    expect(asObjectRecord("string")).toEqual({});
  });

  test("returns arrays (they are objects)", () => {
    const arr = [1, 2, 3];
    expect(asObjectRecord(arr)).toBe(arr);
  });
});

describe("asPlainObjectRecord", () => {
  test("returns plain objects as-is", () => {
    expect(asPlainObjectRecord({ a: 1 })).toEqual({ a: 1 });
  });

  test("rejects arrays", () => {
    expect(asPlainObjectRecord([1, 2, 3])).toEqual({});
  });

  test("returns empty record for non-objects", () => {
    expect(asPlainObjectRecord(null)).toEqual({});
    expect(asPlainObjectRecord(undefined)).toEqual({});
  });
});
