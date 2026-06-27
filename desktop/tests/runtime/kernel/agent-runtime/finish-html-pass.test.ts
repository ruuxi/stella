import { describe, expect, it } from "vitest";
import { findHtmlToolCall } from "../../../../../runtime/kernel/agent-runtime/finish-html-pass.js";
import type {
  AssistantMessage,
  TextContent,
  ToolCall,
} from "../../../../../runtime/ai/types.js";

const text = (value: string): TextContent => ({ type: "text", text: value });

const toolCall = (name: string, args: Record<string, unknown>): ToolCall => ({
  type: "toolCall",
  id: `call-${name}`,
  name,
  arguments: args,
});

const message = (
  content: AssistantMessage["content"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openrouter",
  model: "stella/default",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

describe("findHtmlToolCall", () => {
  it("returns the html tool call with its arguments", () => {
    const call = toolCall("html", {
      slug: "q3-report",
      title: "Q3 Report",
      html: "<!doctype html><html><body>ok</body></html>",
    });
    expect(findHtmlToolCall(message([call]))).toBe(call);
  });

  it("finds the html call among text + other content", () => {
    const call = toolCall("html", { slug: "plan", title: "Plan", html: "<html></html>" });
    expect(
      findHtmlToolCall(message([text("Rendering a canvas."), call])),
    ).toBe(call);
  });

  it("returns null when the model answered in chat (no tool call)", () => {
    expect(
      findHtmlToolCall(message([text("Yes, the service is running.")])),
    ).toBeNull();
  });

  it("returns null when only a different tool was called", () => {
    expect(
      findHtmlToolCall(message([toolCall("exec_command", { cmd: "ls" })])),
    ).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(findHtmlToolCall(message([]))).toBeNull();
  });
});
