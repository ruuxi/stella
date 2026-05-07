import { describe, expect, it } from "vitest";
import { parseRuntimeThreadPayload } from "../../../../../runtime/kernel/storage/shared.js";

const VALID_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("parseRuntimeThreadPayload", () => {
  it("preserves unknown fields on an assistant message round trip", () => {
    // Simulates a future addition to AssistantMessage (e.g. cacheControl,
    // reasoningContent, modelMetadata) landing in storage before
    // parseRuntimeThreadPayload knows about it. The unknown field must ride
    // through unchanged instead of being silently dropped on read.
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-completions",
      provider: "openai",
      model: "test-model",
      usage: VALID_USAGE,
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
      cacheControl: "ephemeral",
      modelMetadata: { foo: "bar" },
    });

    const parsed = parseRuntimeThreadPayload(stored) as
      | (Record<string, unknown> & { role: "assistant" })
      | undefined;

    expect(parsed).toBeDefined();
    expect(parsed?.role).toBe("assistant");
    expect(parsed?.cacheControl).toBe("ephemeral");
    expect(parsed?.modelMetadata).toEqual({ foo: "bar" });
  });

  it("preserves unknown fields on a user message round trip", () => {
    const stored = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1_700_000_000_000,
      futureField: { nested: 42 },
    });

    const parsed = parseRuntimeThreadPayload(stored) as
      | (Record<string, unknown> & { role: "user" })
      | undefined;

    expect(parsed).toBeDefined();
    expect(parsed?.role).toBe("user");
    expect(parsed?.futureField).toEqual({ nested: 42 });
  });

  it("preserves unknown fields on a toolResult message round trip", () => {
    const stored = JSON.stringify({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "some_tool",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      timestamp: 1_700_000_000_000,
      providerHint: "anthropic",
    });

    const parsed = parseRuntimeThreadPayload(stored) as
      | (Record<string, unknown> & { role: "toolResult" })
      | undefined;

    expect(parsed).toBeDefined();
    expect(parsed?.role).toBe("toolResult");
    expect(parsed?.providerHint).toBe("anthropic");
  });

  it("still returns undefined for invalid records", () => {
    expect(parseRuntimeThreadPayload(null)).toBeUndefined();
    expect(parseRuntimeThreadPayload("not json")).toBeUndefined();
    expect(parseRuntimeThreadPayload("[]")).toBeUndefined();
    // Wrong-typed required field must still fail validation.
    expect(
      parseRuntimeThreadPayload(
        JSON.stringify({
          role: "user",
          content: 123,
          timestamp: 1,
        }),
      ),
    ).toBeUndefined();
    // Missing required field must still fail validation even with extras.
    expect(
      parseRuntimeThreadPayload(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          // Missing usage / api / provider / model / stopReason / timestamp.
          unknownExtra: "ignored",
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps known optional fields working alongside passthrough", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-completions",
      provider: "openai",
      model: "test-model",
      usage: VALID_USAGE,
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
      responseId: "resp_123",
      errorMessage: "transient",
      futureExtra: true,
    });

    const parsed = parseRuntimeThreadPayload(stored) as
      | (Record<string, unknown> & { role: "assistant" })
      | undefined;

    expect(parsed?.responseId).toBe("resp_123");
    expect(parsed?.errorMessage).toBe("transient");
    expect(parsed?.futureExtra).toBe(true);
  });
});
