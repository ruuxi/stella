import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../../../../runtime/ai/types.js";
import { AssistantMessageEventStream } from "../../../../../runtime/ai/utils/event-stream.js";
import { isContextOverflow } from "../../../../../runtime/ai/utils/overflow.js";
import { runAgentLoop } from "../../../../../runtime/kernel/agent-core/agent-loop.js";

const OVERFLOW_CONTEXT_WINDOW = 80_000;

const usage = {
  input: 81_000,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 81_010,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const assistantMessage = (args: {
  provider: string;
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Completed successfully." }],
  api: "openai-responses",
  provider: args.provider,
  model: "test-model",
  usage,
  stopReason: args.stopReason ?? "stop",
  ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
  timestamp: 1,
});

const streamMessage = (
  message: AssistantMessage,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
};

const runWithProvider = async (
  configuredProvider: string,
  response: AssistantMessage,
): Promise<AssistantMessage> => {
  const messages = await runAgentLoop(
    [{ role: "user", content: "Continue the task.", timestamp: 1 }],
    { systemPrompt: "Complete the task.", messages: [], tools: [] },
    {
      model: {
        provider: configuredProvider,
        id: "test-model",
        contextWindow: OVERFLOW_CONTEXT_WINDOW,
      },
      convertToLlm: async (input) => input,
    } as never,
    () => {},
    undefined,
    async () => streamMessage(response),
  );
  return messages.at(-1) as AssistantMessage;
};

describe("agent loop context overflow classification", () => {
  it.each([
    ["OpenAI", "openai", "openai"],
    ["Stella-managed OpenAI", "stella", "openai"],
  ])(
    "keeps a successful %s response above fallback metadata successful",
    async (_label, configuredProvider, responseProvider) => {
      const result = await runWithProvider(
        configuredProvider,
        assistantMessage({ provider: responseProvider }),
      );

      expect(result.stopReason).toBe("stop");
      expect(result.errorMessage).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: "Completed successfully." },
      ]);
    },
  );

  it("still catches ZAI silent overflow after a successful response", async () => {
    const result = await runWithProvider(
      "Z.AI",
      assistantMessage({ provider: "ZAI" }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      `Context overflow: model context window is ${OVERFLOW_CONTEXT_WINDOW} tokens.`,
    );
  });

  it("still recognizes and surfaces explicit provider overflow errors", async () => {
    const response = assistantMessage({
      provider: "openai",
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model",
    });

    expect(isContextOverflow(response)).toBe(true);
    const result = await runWithProvider("openai", response);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(response.errorMessage);
  });
});
