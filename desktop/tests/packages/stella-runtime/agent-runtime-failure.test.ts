import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "@stella/stella-runtime/tasks";
import type { JsonlRuntimeStore } from "../../../packages/stella-runtime/src/jsonl_store.js";
import type { ResolvedLlmRoute } from "../../../packages/stella-runtime/src/model-routing.js";

const { mockPromptImpl } = vi.hoisted(() => ({
  mockPromptImpl: vi.fn(),
}));

vi.mock("@stella/stella-agent-core", async () => {
  const actual = await vi.importActual<typeof import("@stella/stella-agent-core")>(
    "@stella/stella-agent-core",
  );

  class MockAgent {
    state: {
      messages: unknown[];
      error?: string;
      pendingToolCalls: Set<string>;
      streamMessage: null;
      isStreaming: boolean;
    };

    constructor(opts: { initialState?: { messages?: unknown[]; error?: string } }) {
      this.state = {
        messages: opts.initialState?.messages ?? [],
        error: opts.initialState?.error,
        pendingToolCalls: new Set<string>(),
        streamMessage: null,
        isStreaming: false,
      };
    }

    subscribe() {
      return () => undefined;
    }

    async prompt(message: unknown) {
      await mockPromptImpl(this, message);
    }

    abort() {}
  }

  return {
    ...actual,
    Agent: MockAgent,
  };
});

import {
  runOrchestratorTurn,
  runSubagentTask,
} from "@stella/stella-runtime/agent-runtime";

type StoreStub = {
  appendThreadMessage: ReturnType<typeof vi.fn>;
  loadThreadMessages: ReturnType<typeof vi.fn>;
  recordRunEvent: ReturnType<typeof vi.fn>;
  saveMemory: ReturnType<typeof vi.fn>;
  recallMemories: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const createStoreStub = (): StoreStub => ({
  appendThreadMessage: vi.fn(),
  loadThreadMessages: vi.fn().mockReturnValue([]),
  recordRunEvent: vi.fn(),
  saveMemory: vi.fn(),
  recallMemories: vi.fn().mockReturnValue([]),
  close: vi.fn(),
});

const buildAgentContext = (
  overrides?: Partial<LocalTaskManagerAgentContext>,
): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "",
  model: "openai/gpt-4.1-mini",
  maxTaskDepth: 4,
  defaultSkills: [],
  skillIds: [],
  ...overrides,
});

const resolvedLlm = {
  model: {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 100000,
  },
  route: "direct-provider",
  getApiKey: () => "test-key",
} as ResolvedLlmRoute;

const errorAssistantMessage = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "" }],
  api: "openai-responses" as const,
  provider: "openai" as const,
  model: "openai/gpt-4.1-mini",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error" as const,
  errorMessage: "Agent core failed",
  timestamp: 1,
};

describe("agent runtime failure handling", () => {
  beforeEach(() => {
    mockPromptImpl.mockReset();
    mockPromptImpl.mockImplementation(async (agent: { state: { messages: unknown[]; error?: string } }) => {
      agent.state.messages = [...agent.state.messages, errorAssistantMessage];
      agent.state.error = errorAssistantMessage.errorMessage;
    });
  });

  it("records orchestrator core failures as errors instead of blank run_end events", async () => {
    const store = createStoreStub();
    const callbacks = {
      onStream: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
    };

    await expect(runOrchestratorTurn({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Solve this task",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
      deviceId: "device-1",
      stellaHome: "/tmp/.stella",
      resolvedLlm,
      store: store as unknown as JsonlRuntimeStore,
      callbacks,
    })).rejects.toThrow("Agent core failed");

    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "error",
      error: "Agent core failed",
      fatal: true,
    }));
    expect(store.recordRunEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "run_end",
    }));
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({
      error: "Agent core failed",
      fatal: true,
    }));
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });

  it("returns subagent core failures as errors instead of successful blank results", async () => {
    const store = createStoreStub();
    const callbacks = {
      onError: vi.fn(),
      onEnd: vi.fn(),
    };

    const result = await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Solve this task",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
      deviceId: "device-1",
      stellaHome: "/tmp/.stella",
      resolvedLlm,
      store: store as unknown as JsonlRuntimeStore,
      callbacks,
    });

    expect(result).toEqual({
      runId: expect.any(String),
      result: "",
      error: "Agent core failed",
    });
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "error",
      error: "Agent core failed",
      fatal: true,
    }));
    expect(store.recordRunEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "run_end",
    }));
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({
      error: "Agent core failed",
      fatal: true,
    }));
    expect(callbacks.onEnd).not.toHaveBeenCalled();
  });
});
