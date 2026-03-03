import { describe, test, expect } from "bun:test";
import { getVoiceToolSchemas } from "../convex/tools/voice_schemas";

describe("getVoiceToolSchemas", () => {
  test("returns an array", () => {
    const schemas = getVoiceToolSchemas();
    expect(Array.isArray(schemas)).toBe(true);
  });

  test("contains orchestrator_chat tool", () => {
    const schemas = getVoiceToolSchemas();
    const chat = schemas.find((s) => s.name === "orchestrator_chat");
    expect(chat).toBeDefined();
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

  test("orchestrator_chat has message parameter", () => {
    const schemas = getVoiceToolSchemas();
    const chat = schemas.find((s) => s.name === "orchestrator_chat")!;
    const props = chat.parameters as { properties?: Record<string, unknown> };
    expect(props.properties).toBeDefined();
    expect(props.properties!.message).toBeDefined();
  });
});
