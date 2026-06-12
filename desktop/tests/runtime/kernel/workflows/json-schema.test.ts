import { describe, expect, it } from "vitest";
import {
  extractJsonValue,
  validateAgainstSchema,
} from "../../../../../runtime/kernel/workflows/json-schema.js";

describe("validateAgainstSchema", () => {
  it("accepts a value matching a nested object schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" }, maxItems: 5 },
        meta: {
          type: "object",
          properties: { score: { type: "number", minimum: 0 } },
          required: ["score"],
        },
      },
      required: ["name", "meta"],
      additionalProperties: false,
    };
    const result = validateAgainstSchema(
      { name: "ok", tags: ["a", "b"], meta: { score: 3.5 } },
      schema,
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("reports a top-level type mismatch with the $ path", () => {
    expect(validateAgainstSchema("hi", { type: "number" })).toEqual({
      valid: false,
      errors: ["$: expected number, got string"],
    });
  });

  it("distinguishes integer from number", () => {
    expect(validateAgainstSchema(3, { type: "integer" }).valid).toBe(true);
    expect(validateAgainstSchema(3.5, { type: "integer" })).toEqual({
      valid: false,
      errors: ["$: expected integer, got number"],
    });
  });

  it("rejects non-finite numbers for type number", () => {
    // Number.isFinite gates the number type, so Infinity fails even
    // though typeof reports "number" (hence the odd-looking message).
    expect(validateAgainstSchema(Infinity, { type: "number" })).toEqual({
      valid: false,
      errors: ["$: expected number, got number"],
    });
  });

  it("supports type arrays, accepting any listed type", () => {
    const schema = { type: ["string", "null"] };
    expect(validateAgainstSchema("x", schema).valid).toBe(true);
    expect(validateAgainstSchema(null, schema).valid).toBe(true);
    expect(validateAgainstSchema(5, schema)).toEqual({
      valid: false,
      errors: ["$: expected one of [string, null], got number"],
    });
  });

  it("reports missing required properties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    expect(validateAgainstSchema({}, schema)).toEqual({
      valid: false,
      errors: ['$: missing required property "name"'],
    });
  });

  it("builds nested error paths like $.foo[2].bar", () => {
    const schema = {
      type: "object",
      properties: {
        foo: {
          type: "array",
          items: {
            type: "object",
            properties: { bar: { type: "string" } },
          },
        },
      },
    };
    const result = validateAgainstSchema(
      { foo: [{ bar: "a" }, { bar: "b" }, { bar: 7 }] },
      schema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["$.foo[2].bar: expected string, got number"]);
  });

  it("matches enum entries by JSON.stringify equality", () => {
    const schema = { enum: ["a", 2, { a: 1, b: 2 }] };
    expect(validateAgainstSchema("a", schema).valid).toBe(true);
    expect(validateAgainstSchema(2, schema).valid).toBe(true);
    expect(validateAgainstSchema({ a: 1, b: 2 }, schema).valid).toBe(true);
    expect(validateAgainstSchema("c", schema)).toEqual({
      valid: false,
      errors: ["$: not one of the allowed enum values"],
    });
    // stringify equality is key-order sensitive — documented subset behavior.
    expect(validateAgainstSchema({ b: 2, a: 1 }, schema).valid).toBe(false);
  });

  it("flags unexpected properties when additionalProperties is false", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "number" } },
      additionalProperties: false,
    };
    expect(validateAgainstSchema({ a: 1, b: 2 }, schema)).toEqual({
      valid: false,
      errors: ['$: unexpected property "b"'],
    });
  });

  it("enforces minLength and maxLength on strings", () => {
    expect(validateAgainstSchema("ab", { type: "string", minLength: 3 })).toEqual({
      valid: false,
      errors: ["$: string shorter than minLength 3"],
    });
    expect(validateAgainstSchema("abc", { type: "string", maxLength: 2 })).toEqual({
      valid: false,
      errors: ["$: string longer than maxLength 2"],
    });
  });

  it("enforces minimum and maximum on numbers", () => {
    expect(validateAgainstSchema(5, { type: "number", minimum: 10 })).toEqual({
      valid: false,
      errors: ["$: below minimum 10"],
    });
    expect(validateAgainstSchema(11, { type: "number", maximum: 10 })).toEqual({
      valid: false,
      errors: ["$: above maximum 10"],
    });
  });

  it("enforces minItems and maxItems on arrays", () => {
    expect(validateAgainstSchema([1], { type: "array", minItems: 2 })).toEqual({
      valid: false,
      errors: ["$: fewer than minItems 2"],
    });
    expect(
      validateAgainstSchema([1, 2, 3], { type: "array", maxItems: 2 }),
    ).toEqual({
      valid: false,
      errors: ["$: more than maxItems 2"],
    });
  });

  it("collects multiple errors instead of stopping at the first", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
    };
    const result = validateAgainstSchema({ a: 1, b: "x" }, schema);
    expect(result.errors).toEqual([
      "$.a: expected string, got number",
      "$.b: expected number, got string",
    ]);
  });

  it("caps reported errors at 20", () => {
    const value = Array.from({ length: 25 }, (_, i) => i);
    const result = validateAgainstSchema(value, {
      type: "array",
      items: { type: "string" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(20);
  });

  it("ignores unknown keywords and non-required absent properties", () => {
    expect(
      validateAgainstSchema("user@example.com", {
        type: "string",
        format: "email",
        pattern: "irrelevant",
      }).valid,
    ).toBe(true);
    expect(
      validateAgainstSchema(
        {},
        { type: "object", properties: { a: { type: "string" } } },
      ).valid,
    ).toBe(true);
  });
});

describe("extractJsonValue", () => {
  it("prefers the LAST fenced json block", () => {
    const text = [
      "First attempt:",
      "```json",
      '{"first": 1}',
      "```",
      "Actually, corrected:",
      "```json",
      '{"second": 2}',
      "```",
    ].join("\n");
    expect(extractJsonValue(text)).toEqual({ second: 2 });
  });

  it("falls back to an earlier fence when the last one does not parse", () => {
    const text = [
      "```json",
      '{"valid": true}',
      "```",
      "and then",
      "```",
      "definitely not json",
      "```",
    ].join("\n");
    expect(extractJsonValue(text)).toEqual({ valid: true });
  });

  it("accepts a fenced block without a json tag", () => {
    const text = ["Result:", "```", "[1, 2]", "```", "done"].join("\n");
    expect(extractJsonValue(text)).toEqual([1, 2]);
  });

  it("prefers a parsing fence over a bare braces span", () => {
    const text = [
      'Outer {"wide": true} text',
      "```json",
      '{"fence": 1}',
      "```",
    ].join("\n");
    expect(extractJsonValue(text)).toEqual({ fence: 1 });
  });

  it("extracts the widest braces span when there is no fence", () => {
    expect(extractJsonValue('The answer is {"a": 1}, done.')).toEqual({ a: 1 });
  });

  it("extracts a bracket span when no braces span parses", () => {
    expect(extractJsonValue("between {curly} braces [1, 2, 3]")).toEqual([
      1, 2, 3,
    ]);
  });

  it("falls back to the span when the only fence does not parse", () => {
    const text = ["```", "not json", "```", 'The data: {"a": 3}'].join("\n");
    expect(extractJsonValue(text)).toEqual({ a: 3 });
  });

  it("parses bare JSON text and fenced scalars", () => {
    expect(extractJsonValue('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJsonValue("```json\n42\n```")).toBe(42);
    expect(extractJsonValue("```json\ntrue\n```")).toBe(true);
  });

  it("returns undefined when nothing parses", () => {
    expect(extractJsonValue("no json here at all")).toBeUndefined();
    expect(extractJsonValue("")).toBeUndefined();
    expect(extractJsonValue("   ")).toBeUndefined();
    expect(extractJsonValue("set {a: 1} ok")).toBeUndefined();
  });
});
