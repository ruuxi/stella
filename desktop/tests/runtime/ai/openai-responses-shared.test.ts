import { describe, expect, it } from "vitest";

import { normalizeOpenAIFunctionName } from "../../../../runtime/ai/providers/openai-responses-shared";

describe("runtime OpenAI Responses function names", () => {
  it("keeps canonical underscore tool names unchanged", () => {
    expect(normalizeOpenAIFunctionName("multi_tool_use_parallel")).toBe(
      "multi_tool_use_parallel",
    );
  });

  it("migrates the legacy dotted parallel tool name", () => {
    expect(normalizeOpenAIFunctionName("multi_tool_use.parallel")).toBe(
      "multi_tool_use_parallel",
    );
  });

  it("rejects unknown invalid tool names instead of silently rewriting them", () => {
    expect(() => normalizeOpenAIFunctionName("some.tool")).toThrow(
      "Invalid OpenAI Responses function name",
    );
  });
});
