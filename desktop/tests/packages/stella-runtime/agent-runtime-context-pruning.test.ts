import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../packages/runtime-kernel/agent-core/types.js";
import type { LocalTaskManagerAgentContext } from "../../../packages/runtime-kernel/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../packages/runtime-kernel/model-routing.js";
import type { RuntimeStore } from "../../../packages/runtime-kernel/storage/runtime-store.js";

const { capturedTransforms } = vi.hoisted(() => ({
  capturedTransforms: [] as AgentMessage[][],
}));

vi.mock("../../../packages/runtime-kernel/agent-core/agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/agent-core/agent.js")>(
    "../../../packages/runtime-kernel/agent-core/agent.js",
  );

  class MockAgent {
    state: {
      messages: AgentMessage[];
      error?: string;
      pendingToolCalls: Set<string>;
      streamMessage: null;
      isStreaming: boolean;
    };
    private readonly transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

    constructor(opts: {
      initialState?: { messages?: AgentMessage[]; error?: string };
      transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    }) {
      this.state = {
        messages: opts.initialState?.messages ?? [],
        error: opts.initialState?.error,
        pendingToolCalls: new Set<string>(),
        streamMessage: null,
        isStreaming: false,
      };
      this.transformContext = opts.transformContext;
    }

    subscribe() {
      return () => undefined;
    }

    async prompt(message: AgentMessage) {
      const promptMessages = [...this.state.messages, message];
      const transformed = this.transformContext
        ? await this.transformContext(promptMessages)
        : promptMessages;
      capturedTransforms.push(transformed);
      this.state.messages = [
        ...transformed,
        {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          api: "openai-responses",
          provider: "openai",
          model: "openai/gpt-4.1-mini",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      ];
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

const createStoreStub = () => ({
  appendThreadMessage: vi.fn(),
  loadThreadMessages: vi.fn().mockReturnValue([]),
  recordRunEvent: vi.fn(),
  saveMemory: vi.fn(),
  recallMemories: vi.fn().mockReturnValue([]),
  close: vi.fn(),
});

const buildLongHistory = (count = 6): Array<{ role: string; content: string }> =>
  Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `history-${index} ${"x".repeat(9_000)}`,
  }));

const buildAgentContext = (
  overrides?: Partial<LocalTaskManagerAgentContext>,
): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "",
  model: "openai/gpt-4.1-mini",
  maxTaskDepth: 4,
  defaultSkills: [],
  skillIds: [],
  threadHistory: buildLongHistory(),
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
    contextWindow: 12_000,
    maxTokens: 4_000,
  },
  route: "direct-provider",
  getApiKey: () => "test-key",
} as ResolvedLlmRoute;

describe("agent runtime context pruning", () => {
  beforeEach(() => {
    capturedTransforms.length = 0;
  });

  it("prunes oversized orchestrator history before provider calls", async () => {
    const store = createStoreStub();

    await runOrchestratorTurn({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "orchestrator",
      userPrompt: "Continue the work",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
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

    expect(capturedTransforms).toHaveLength(1);
    const transformed = capturedTransforms[0]!;
    expect(transformed.length).toBeLessThan(buildAgentContext().threadHistory!.length + 1);
    expect(transformed.some((message) =>
      message.role !== "toolResult" &&
      typeof message.content !== "string" &&
      message.content.some((block) => block.type === "text" && block.text.includes("history-0")))).toBe(false);
    const lastMessage = transformed[transformed.length - 1];
    expect(lastMessage?.role).toBe("user");
    expect(typeof lastMessage?.content).not.toBe("string");
    expect((lastMessage?.content as Array<{ type: string; text?: string }>)[0]?.text).toContain("Continue the work");
  });

  it("prunes oversized subagent history before provider calls", async () => {
    const store = createStoreStub();

    await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Solve this task",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
      deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
      resolvedLlm,
      store: store as unknown as RuntimeStore,
      callbacks: {
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
    });

    expect(capturedTransforms).toHaveLength(1);
    const transformed = capturedTransforms[0]!;
    expect(transformed.length).toBeLessThan(buildAgentContext().threadHistory!.length + 1);
    expect(transformed.some((message) =>
      message.role !== "toolResult" &&
      typeof message.content !== "string" &&
      message.content.some((block) => block.type === "text" && block.text.includes("history-0")))).toBe(false);
    const lastMessage = transformed[transformed.length - 1];
    expect(lastMessage?.role).toBe("user");
    expect(typeof lastMessage?.content).not.toBe("string");
    expect((lastMessage?.content as Array<{ type: string; text?: string }>)[0]?.text).toContain("Solve this task");
  });
});


