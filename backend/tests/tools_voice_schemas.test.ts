import { describe, test, expect } from "bun:test";
import { getVoiceToolSchemas } from "../convex/tools/voice_schemas";

describe("getVoiceToolSchemas", () => {
  test("returns an array", () => {
    const schemas = getVoiceToolSchemas();
    expect(Array.isArray(schemas)).toBe(true);
  });

  test("contains perform_action tool", () => {
    const schemas = getVoiceToolSchemas();
    const action = schemas.find((s) => s.name === "perform_action");
    expect(action).toBeDefined();
  });

  test("each schema has required fields", () => {
    const schemas = getVoiceToolSchemas();
    for (const schema of schemas) {
      expect(schema.type).toBe("function");
      expect(typeof schema.name).toBe("string");
      expect(typeof schema.description).toBe("string");
      expect(typeof schema.parameters).toBe("object");
    }
  });

  test("perform_action uses an object parameter schema", () => {
    const schemas = getVoiceToolSchemas();
    const action = schemas.find((s) => s.name === "perform_action")!;
    const params = action.parameters as { type?: string; properties?: Record<string, unknown> };
    expect(params.type).toBe("object");
    expect(params.properties).toBeDefined();
  });
});
