import { describe, test, expect } from "bun:test";
import { isPlainObject, validateAgainstSchema } from "../convex/lib/validator";

describe("isPlainObject", () => {
  test("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test("returns false for arrays", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
  });

  test("returns false for null and undefined", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });

  test("returns false for primitives", () => {
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });
});

describe("validateAgainstSchema", () => {
  test("passes when schema is undefined", () => {
    expect(validateAgainstSchema(undefined, "anything")).toEqual({ ok: true });
  });

  // --- Object schema ---

  test("validates object type", () => {
    const schema = { type: "object" };
    expect(validateAgainstSchema(schema, { a: 1 })).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, "string").ok).toBe(false);
    expect(validateAgainstSchema(schema, []).ok).toBe(false);
  });

  test("checks required fields", () => {
    const schema = { type: "object", required: ["name", "age"] };
    expect(validateAgainstSchema(schema, { name: "Alice", age: 30 })).toEqual({ ok: true });
    const result = validateAgainstSchema(schema, { name: "Alice" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("age");
  });

  test("validates property types", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        active: { type: "boolean" },
        items: { type: "array" },
      },
    };
    expect(validateAgainstSchema(schema, { name: "A", count: 1, active: true, items: [] })).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, { name: 123 }).ok).toBe(false);
    expect(validateAgainstSchema(schema, { count: "not a number" }).ok).toBe(false);
    expect(validateAgainstSchema(schema, { active: "yes" }).ok).toBe(false);
    expect(validateAgainstSchema(schema, { items: "not array" }).ok).toBe(false);
  });

  test("validates enum constraints", () => {
    const schema = {
      type: "object",
      properties: { status: { enum: ["active", "inactive"] } },
    };
    expect(validateAgainstSchema(schema, { status: "active" })).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, { status: "unknown" }).ok).toBe(false);
  });

  test("validates maxLength constraint", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string", maxLength: 5 } },
    };
    expect(validateAgainstSchema(schema, { name: "hi" })).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, { name: "toolong" }).ok).toBe(false);
  });

  test("validates maxItems constraint on object properties", () => {
    const schema = {
      type: "object",
      properties: { tags: { type: "array", maxItems: 2 } },
    };
    expect(validateAgainstSchema(schema, { tags: [1, 2] })).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, { tags: [1, 2, 3] }).ok).toBe(false);
  });

  test("skips absent optional properties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    expect(validateAgainstSchema(schema, {})).toEqual({ ok: true });
  });

  // --- Array schema ---

  test("validates array type", () => {
    const schema = { type: "array" };
    expect(validateAgainstSchema(schema, [1, 2])).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, "not array").ok).toBe(false);
  });

  test("validates array maxItems", () => {
    const schema = { type: "array", maxItems: 3 };
    expect(validateAgainstSchema(schema, [1, 2, 3])).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, [1, 2, 3, 4]).ok).toBe(false);
  });

  // --- Primitive schemas ---

  test("validates string type", () => {
    const schema = { type: "string" };
    expect(validateAgainstSchema(schema, "hello")).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, 42).ok).toBe(false);
  });

  test("validates number type", () => {
    const schema = { type: "number" };
    expect(validateAgainstSchema(schema, 42)).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, "42").ok).toBe(false);
  });

  test("validates boolean type", () => {
    const schema = { type: "boolean" };
    expect(validateAgainstSchema(schema, true)).toEqual({ ok: true });
    expect(validateAgainstSchema(schema, 1).ok).toBe(false);
  });

  // --- Edge cases ---

  test("passes anything when schema has no type", () => {
    expect(validateAgainstSchema({}, "anything")).toEqual({ ok: true });
    expect(validateAgainstSchema({}, 42)).toEqual({ ok: true });
  });
});
