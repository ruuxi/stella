import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "../../../packages/runtime-kernel/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../packages/runtime-kernel/model-routing.js";
import type { RuntimeStore } from "../../../packages/runtime-kernel/storage/runtime-store.js";

const { mockPromptImpl, lastPromptText } = vi.hoisted(() => ({
  mockPromptImpl: vi.fn(),
  lastPromptText: { current: "" },
}));

vi.mock("../../../packages/runtime-kernel/agent-core/agent.js", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/runtime-kernel/agent-core/agent.js")>(
    "../../../packages/runtime-kernel/agent-core/agent.js",
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

import { runOrchestratorTurn } from "../../../packages/runtime-kernel/agent-runtime.js";

const buildAgentContext = (
  overrides?: Partial<LocalTaskManagerAgentContext>,
): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "",
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

describe("agent runtime orchestrator thread reminders", () => {
  beforeEach(() => {
    lastPromptText.current = "";
    mockPromptImpl.mockReset();
    mockPromptImpl.mockImplementation(async (agent: { state: { messages: unknown[] } }, message) => {
      const typedMessage = message as { content?: Array<{ type: string; text?: string }> };
      lastPromptText.current = typedMessage.content?.[0]?.text ?? "";
      agent.state.messages = [...agent.state.messages, successAssistantMessage];
    });
  });

  it("appends active-thread context as a periodic reminder and resets the reminder counter", async () => {
    const store = {
      appendThreadMessage: vi.fn(),
      loadThreadMessages: vi.fn().mockReturnValue([]),
      recordRunEvent: vi.fn(),
      saveMemory: vi.fn(),
      recallMemories: vi.fn().mockReturnValue([]),
      close: vi.fn(),
      updateOrchestratorReminderCounter: vi.fn(),
    };

    await runOrchestratorTurn({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "orchestrator",
      userPrompt: "Continue the work",
      agentContext: buildAgentContext({
        orchestratorReminderText: "# Active Threads\n- apollo (general, last used just now)",
        shouldInjectDynamicReminder: true,
      }),
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

    expect(lastPromptText.current).toContain("Continue the work");
    expect(lastPromptText.current).toContain("<system-context>");
    expect(lastPromptText.current).toContain("# Active Threads");
    expect(store.updateOrchestratorReminderCounter).toHaveBeenCalledWith({
      conversationId: "conv-1",
      resetTo: 0,
    });
  });
});


