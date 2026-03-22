import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "../../../packages/runtime-kernel/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../packages/runtime-kernel/model-routing.js";
import type { RuntimeStore } from "../../../packages/runtime-kernel/storage/runtime-store.js";

const { mockPromptImpl } = vi.hoisted(() => ({
  mockPromptImpl: vi.fn(),
}));

vi.mock("../../../packages/runtime-kernel/agent-core/agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/agent-core/agent.js")>(
    "../../../packages/runtime-kernel/agent-core/agent.js",
  );

  class MockAgent {
    state: {
      messages: unknown[];
      error?: string;
      tools: Array<{
        name: string;
        execute: (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<unknown>;
      }>;
      pendingToolCalls: Set<string>;
      streamMessage: null;
      isStreaming: boolean;
    };

    constructor(opts: {
      initialState?: {
        messages?: unknown[];
        error?: string;
        tools?: Array<{
          name: string;
          execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ) => Promise<unknown>;
        }>;
      };
    }) {
      this.state = {
        messages: opts.initialState?.messages ?? [],
        error: opts.initialState?.error,
        tools: opts.initialState?.tools ?? [],
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
} from "../../../packages/runtime-kernel/agent-runtime.js";

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

const successAssistantMessage = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Done" }],
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
  stopReason: "stop" as const,
  timestamp: 1,
};

describe("agent runtime cancellation propagation", () => {
  beforeEach(() => {
    mockPromptImpl.mockReset();
    mockPromptImpl.mockImplementation(async (agent: {
      state: {
        messages: unknown[];
        tools: Array<{
          execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ) => Promise<unknown>;
        }>;
      };
    }) => {
      const controller = new AbortController();
      const [tool] = agent.state.tools;
      await tool.execute("tool-call-1", { file_path: "notes.txt" }, controller.signal);
      agent.state.messages = [...agent.state.messages, successAssistantMessage];
    });
  });

  it("passes the tool execution AbortSignal into orchestrator toolExecutor", async () => {
    const store = createStoreStub();
    const toolExecutor = vi.fn().mockResolvedValue({ result: "ok" });

    await runOrchestratorTurn({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Use a tool",
      agentContext: buildAgentContext(),
      toolExecutor,
      deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
      resolvedLlm,
      store: store as unknown as RuntimeStore,
      callbacks: {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
    });

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it("passes the tool execution AbortSignal into subagent toolExecutor", async () => {
    const store = createStoreStub();
    const toolExecutor = vi.fn().mockResolvedValue({ result: "ok" });

    const result = await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Use a tool",
      agentContext: buildAgentContext(),
      toolExecutor,
      deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
      resolvedLlm,
      store: store as unknown as RuntimeStore,
    });

    expect(result.error).toBeUndefined();
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });
});


