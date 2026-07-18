import { describe, expect, it, vi } from "vitest";
import { executeAgentTurnWithRetry } from "../../../../../runtime/kernel/agent-runtime/agent-run-retry.js";
import { executeRuntimeAgentPrompt } from "../../../../../runtime/kernel/agent-runtime/run-execution.js";

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
    const appendThreadCustomMessage = vi.fn();
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
        appendThreadCustomMessage,
      } as never,
      threadKey: "thread-1",
    });

    expect(result.finalText).toBe("done");
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "runtimeInternal",
      }),
    ]);
    expect(appendThreadMessage).not.toHaveBeenCalled();
    expect(appendThreadCustomMessage).not.toHaveBeenCalled();
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

  it("fails a silent native agent prompt instead of hanging", async () => {
    const previousTimeout = process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS = "25";
    const listeners = new Set<(event: never) => void>();
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn((listener: (event: never) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(() => new Promise<void>(() => {})),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    try {
      await expect(
        executeRuntimeAgentPrompt({
          agent,
          promptText: "silent",
          runId: "run-3",
          agentType: "general",
          userMessageId: "msg-3",
          recorder: {} as never,
        }),
      ).rejects.toThrow("Agent did not produce activity");
      expect(agent.abort).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("waits for a watchdog-aborted Agent loop to settle before retrying", async () => {
    const previousTimeout = process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS = "25";
    let processing = false;
    let settlePrompt: (() => void) | undefined;
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(() => {
        processing = true;
        return new Promise<void>((resolve) => {
          settlePrompt = resolve;
        });
      }),
      followUp: vi.fn(),
      continue: vi.fn(async () => {
        if (processing) {
          throw new Error(
            "Agent is already processing. Wait for completion before continuing.",
          );
        }
        agent.state.messages = [createAssistantMessage("recovered")];
      }),
      abort: vi.fn(() => {
        setTimeout(() => {
          processing = false;
          agent.state.messages = [
            {
              ...createAssistantMessage(""),
              content: [],
              stopReason: "error",
              errorMessage: "Agent did not produce activity for 0s.",
            } as never,
          ];
          settlePrompt?.();
        }, 50);
      }),
    };

    try {
      const result = await executeAgentTurnWithRetry({
        execute: (resume) =>
          executeRuntimeAgentPrompt({
            agent,
            promptText: "recover after the watchdog",
            runId: "run-watchdog-retry",
            agentType: "general",
            userMessageId: "msg-watchdog-retry",
            recorder: {} as never,
            resume,
          }),
        prepareRetry: () => {
          agent.state.messages.pop();
          return true;
        },
        random: () => 0.5,
        sleep: async () => undefined,
      });

      expect(result).toEqual({ finalText: "recovered", attempts: 2 });
      expect(agent.prompt).toHaveBeenCalledOnce();
      expect(agent.abort).toHaveBeenCalledOnce();
      expect(agent.continue).toHaveBeenCalledOnce();
      expect(processing).toBe(false);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("does not treat a silent in-flight tool as an idle agent", async () => {
    const previousTimeout = process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = "25";
    const listeners = new Set<(event: never) => void>();
    let idleListener: ((event: never) => void) | undefined;
    let finishPrompt: (() => void) | undefined;
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn((listener: (event: never) => void) => {
        idleListener ??= listener;
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(
        () => new Promise<void>((resolve) => {
          finishPrompt = resolve;
        }),
      ),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    try {
      const execution = executeRuntimeAgentPrompt({
        agent,
        promptText: "run a long command",
        runId: "run-4",
        agentType: "general",
        userMessageId: "msg-4",
        recorder: {} as never,
      });
      await vi.waitFor(() => expect(idleListener).toBeDefined());
      idleListener?.({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "exec_command",
        args: {},
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(agent.abort).not.toHaveBeenCalled();

      agent.state.messages = [createAssistantMessage("done")];
      idleListener?.({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "exec_command",
        result: { content: [], details: {} },
        isError: false,
      } as never);
      finishPrompt?.();
      await expect(execution).resolves.toMatchObject({ finalText: "done" });
      expect(agent.abort).not.toHaveBeenCalled();
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("aborts the run at the tool ceiling when in-flight tool tracking leaks", async () => {
    const previousIdle = process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
    const previousToolIdle = process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = "25";
    process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS = "60";
    let idleListener: ((event: never) => void) | undefined;
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn((listener: (event: never) => void) => {
        idleListener ??= listener;
        return () => {};
      }),
      prompt: vi.fn(() => new Promise<void>(() => {})),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    try {
      const execution = executeRuntimeAgentPrompt({
        agent,
        promptText: "run a command whose end event is lost",
        runId: "run-5",
        agentType: "general",
        userMessageId: "msg-5",
        recorder: {} as never,
      });
      await vi.waitFor(() => expect(idleListener).toBeDefined());
      idleListener?.({
        type: "tool_execution_start",
        toolCallId: "tool-leaked",
        toolName: "exec_command",
        args: {},
      } as never);
      // Outlives the plain idle window (25ms) because a tool is in flight...
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(agent.abort).not.toHaveBeenCalled();
      // ...but the tool ceiling (60ms) still bounds a leaked entry.
      await expect(execution).rejects.toThrow(/still marked in flight/);
      expect(agent.abort).toHaveBeenCalled();
    } finally {
      if (previousIdle === undefined) {
        delete process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = previousIdle;
      }
      if (previousToolIdle === undefined) {
        delete process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS = previousToolIdle;
      }
    }
  });
});
