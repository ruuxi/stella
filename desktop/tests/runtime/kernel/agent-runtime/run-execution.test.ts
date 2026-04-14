import { describe, expect, it, vi } from "vitest";
import { executeRuntimeAgentPrompt } from "../../../../runtime/kernel/agent-runtime/run-execution.js";

const createAssistantMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "openai",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop" as const,
  timestamp: 1,
});

describe("executeRuntimeAgentPrompt", () => {
  it("does not persist or emit internal message prompts", async () => {
    const appendThreadMessage = vi.fn();
    const onUserMessage = vi.fn();
    const prompt = vi.fn(async () => {
      agent.state.messages = [createAssistantMessage("done")];
    });
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: () => () => {},
      prompt,
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    const result = await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [{
        text: "Hidden reminder",
        uiVisibility: "hidden",
        messageType: "message",
      }],
      runId: "run-1",
      agentType: "orchestrator",
      userMessageId: "msg-1",
      recorder: {} as never,
      callbacks: { onUserMessage },
      threadStore: {
        appendThreadMessage,
      } as never,
      threadKey: "thread-1",
    });

    expect(result.finalText).toBe("done");
    expect(prompt).toHaveBeenCalledOnce();
    expect(appendThreadMessage).not.toHaveBeenCalled();
    expect(onUserMessage).not.toHaveBeenCalled();
  });

  it("keeps persisting and emitting user prompt messages", async () => {
    const appendThreadMessage = vi.fn();
    const onUserMessage = vi.fn();
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: () => () => {},
      prompt: vi.fn(async () => {
        agent.state.messages = [createAssistantMessage("done")];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [{
        text: "Visible user message",
        uiVisibility: "visible",
      }],
      runId: "run-2",
      agentType: "orchestrator",
      userMessageId: "msg-2",
      recorder: {} as never,
      callbacks: { onUserMessage },
      threadStore: {
        appendThreadMessage,
      } as never,
      threadKey: "thread-2",
    });

    expect(appendThreadMessage).toHaveBeenCalledOnce();
    expect(onUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: "msg-2",
        text: "Visible user message",
        uiVisibility: "visible",
      }),
    );
  });
});
