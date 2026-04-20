import { describe, expect, it } from "vitest";
import { dispatchLocalTool } from "../../../../../runtime/kernel/tools/local-tool-dispatch.js";
import {
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
} from "../../../../../runtime/kernel/tools/schemas.js";
import { TOOL_IDS } from "../../../../../desktop/src/shared/contracts/agent-runtime.js";

describe("Explore tool registration", () => {
  it("declares an Explore JSON schema with a required 'question' string", () => {
    const schema = TOOL_JSON_SCHEMAS[TOOL_IDS.EXPLORE] as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["question"]);
    expect(schema.properties.question?.type).toBe("string");
  });

  it("declares a non-empty Explore tool description", () => {
    const description = TOOL_DESCRIPTIONS[TOOL_IDS.EXPLORE];
    expect(description).toBeTruthy();
    expect(description.length).toBeGreaterThan(20);
    expect(description).toMatch(/explore_findings/);
  });
});

describe("dispatchLocalTool: Explore failure paths", () => {
  it("returns an unavailable findings block when no explore handler is wired", async () => {
    const result = await dispatchLocalTool(
      TOOL_IDS.EXPLORE,
      { question: "anything" },
      { conversationId: "conv-1" },
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.text).toContain('status="unavailable"');
    expect(result.text).toContain("explore_findings");
  });

  it("returns an unavailable block when the question is empty", async () => {
    const result = await dispatchLocalTool(
      TOOL_IDS.EXPLORE,
      { question: "   " },
      {
        conversationId: "conv-1",
        explore: async () => "should not be called",
      },
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.text).toContain('status="unavailable"');
    expect(result.text).toContain("question was empty");
  });

  it("forwards the question to the explore handler and returns its text", async () => {
    let receivedQuestion: string | null = null;
    let receivedConversationId: string | null = null;
    let receivedSignal: AbortSignal | undefined;
    const fakeFindings = `<explore_findings>{"relevant":[],"maybe":[],"nothing_found_for":[]}</explore_findings>`;
    const signal = new AbortController().signal;
    const result = await dispatchLocalTool(
      TOOL_IDS.EXPLORE,
      { question: "find dark mode toggle" },
      {
        conversationId: "conv-2",
        signal,
        explore: async ({ conversationId, question, signal: handlerSignal }) => {
          receivedConversationId = conversationId;
          receivedQuestion = question;
          receivedSignal = handlerSignal;
          return fakeFindings;
        },
      },
    );
    expect(receivedConversationId).toBe("conv-2");
    expect(receivedQuestion).toBe("find dark mode toggle");
    expect(receivedSignal).toBe(signal);
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.text).toBe(fakeFindings);
  });
});
