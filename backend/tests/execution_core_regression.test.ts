import fs from "fs";
import path from "path";
import { describe, expect, test } from "bun:test";
import {
  appendAssistantStepText,
  splitDurationAcrossModels,
  ToolLoopExhaustedError,
} from "../convex/agent/model_execution";
import type { AssistantMessage } from "../convex/runtime_ai/types";

const backendRoot = path.resolve(__dirname, "..");
const readBackendFile = (relativePath: string): string =>
  fs.readFileSync(path.join(backendRoot, relativePath), "utf8");

describe("execution core regressions", () => {
  test("shared model execution helper is used by major backend execution paths", () => {
    const automationRunner = readBackendFile("convex/automation/runner.ts");
    const httpSource = readBackendFile("convex/http.ts");
    const invokeSource = readBackendFile("convex/agent/invoke.ts");

    expect(automationRunner).toContain('from "../agent/model_execution"');
    // http.ts no longer imports model_execution directly — it delegates through stella_provider.
    expect(httpSource).toContain('from "./stella_provider"');
    // invoke.ts now directly uses model_execution (execution.ts wrapper was removed)
    expect(invokeSource).toContain('from "./model_execution"');
    expect(invokeSource).toContain('from "./model_resolver"');
    expect(fs.existsSync(path.join(backendRoot, "convex/agent/tasks.ts"))).toBe(false);
  });

  test("model execution core stays free of Convex action/electron runtime imports", () => {
    const source = readBackendFile("convex/agent/model_execution.ts");

    expect(source).not.toContain("_generated/server");
    expect(source).not.toContain("ActionCtx");
    expect(source).not.toContain("electron");
    expect(source).toContain("streamTextWithFailover");
    expect(source).toContain("generateTextWithFailover");
  });

  test("duration can be split across mixed-model tool-loop usage", () => {
    expect(splitDurationAcrossModels({
      "openai/gpt-5.4": {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      "anthropic/claude-sonnet-4.6": {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      },
    }, 1000)).toEqual([
      {
        model: "openai/gpt-5.4",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        durationMs: 333,
      },
      {
        model: "anthropic/claude-sonnet-4.6",
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
        },
        durationMs: 667,
      },
    ]);
  });

  test("assistant text emitted before tool calls is preserved across later steps", () => {
    const toolStepMessage: AssistantMessage = {
      role: "assistant",
      model: "openai/gpt-5.4",
      content: [
        { type: "text", text: "Looking that up now." },
        {
          type: "toolCall",
          id: "tool_1",
          name: "web_search",
          arguments: {},
        },
      ],
      stopReason: "tool-call",
      usage: {},
      timestamp: Date.now(),
    };

    const finalMessage: AssistantMessage = {
      role: "assistant",
      model: "openai/gpt-5.4",
      content: [{ type: "text", text: "Here is what I found." }],
      stopReason: "stop",
      usage: {},
      timestamp: Date.now(),
    };

    const accumulated = appendAssistantStepText("", toolStepMessage);
    expect(appendAssistantStepText(accumulated, finalMessage)).toBe(
      "Looking that up now.\n\nHere is what I found.",
    );
  });

  test("tool-loop step exhaustion is surfaced as an explicit non-success error", () => {
    const error = new ToolLoopExhaustedError(1, "Partial answer");

    expect(error.name).toBe("ToolLoopExhaustedError");
    expect(error.message).toContain("maxSteps=1");
    expect(error.partialText).toBe("Partial answer");
  });
});
