import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "../../../electron/core/runtime/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../electron/core/runtime/model-routing.js";
import type { RuntimeStore } from "../../../electron/storage/runtime-store.js";

const { mockPromptImpl, capturedToolResult } = vi.hoisted(() => ({
  mockPromptImpl: vi.fn(),
  capturedToolResult: { current: null as unknown },
}));

vi.mock("../../../electron/core/agent/agent", async () => {
  const actual = await vi.importActual<typeof import("../../../electron/core/agent/agent.js")>(
    "../../../electron/core/agent/agent",
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

import { runSubagentTask } from "../../../electron/core/runtime/agent-runtime.js";

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
  toolsAllowlist: ["WebSearch"],
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

describe("agent runtime WebSearch tool payloads", () => {
  beforeEach(() => {
    capturedToolResult.current = null;
    mockPromptImpl.mockReset();
    mockPromptImpl.mockImplementation(async (agent: {
      state: {
        messages: unknown[];
        tools: Array<{
          name: string;
          execute: (
            toolCallId: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ) => Promise<unknown>;
        }>;
      };
    }) => {
      const tool = agent.state.tools.find(({ name }) => name === "WebSearch");
      if (!tool) {
        throw new Error("Expected WebSearch tool");
      }
      capturedToolResult.current = await tool.execute("tool-call-1", {
        query: "stella release notes",
        category: "news",
      });
      agent.state.messages = [...agent.state.messages, successAssistantMessage];
    });
  });

  it("preserves backend text and results in WebSearch tool details", async () => {
    const store = createStoreStub();
    const webSearch = vi.fn().mockResolvedValue({
      text: "Backend summary",
      results: [
        {
          title: "Release post",
          url: "https://example.com/release",
          snippet: "Summary snippet",
        },
      ],
    });

    const result = await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Search the web",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
      deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
      resolvedLlm,
      store: store as unknown as RuntimeStore,
      webSearch,
    });

    expect(result.error).toBeUndefined();
    expect(webSearch).toHaveBeenCalledWith("stella release notes", { category: "news" });
    expect(capturedToolResult.current).toEqual({
      content: [{ type: "text", text: "Backend summary" }],
      details: {
        text: "Backend summary",
        results: [
          {
            title: "Release post",
            url: "https://example.com/release",
            snippet: "Summary snippet",
          },
        ],
      },
    });
  });
});
