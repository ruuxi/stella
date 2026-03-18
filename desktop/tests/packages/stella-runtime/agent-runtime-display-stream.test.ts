import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "../../../electron/core/runtime/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../electron/core/runtime/model-routing.js";
import type { RuntimeStore } from "../../../electron/storage/runtime-store.js";

const { displayHtmlMock } = vi.hoisted(() => ({
  displayHtmlMock: vi.fn(),
}));

vi.mock("../../../electron/core/agent/agent", async () => {
  const actual = await vi.importActual<
    typeof import("../../../electron/core/agent/agent.js")
  >("../../../electron/core/agent/agent");

  class MockAgent {
    state: {
      messages: unknown[];
      error?: string;
      pendingToolCalls: Set<string>;
      streamMessage: null;
      isStreaming: boolean;
    };
    private listener?: (event: unknown) => void;

    constructor(opts: {
      initialState?: { messages?: unknown[]; error?: string };
    }) {
      this.state = {
        messages: opts.initialState?.messages ?? [],
        error: opts.initialState?.error,
        pendingToolCalls: new Set<string>(),
        streamMessage: null,
        isStreaming: false,
      };
    }

    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
      return () => undefined;
    }

    async prompt() {
      this.listener?.({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          partial: {
            content: [
              {
                type: "toolCall",
                name: "Display",
                arguments: {
                  html: "<div><p>Hello from Display output</p></div><script>alert('x')</script>",
                },
              },
            ],
          },
        },
      });

      this.state.messages = [
        ...this.state.messages,
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
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
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

import { runOrchestratorTurn } from "../../../electron/core/runtime/agent-runtime.js";

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

const createStoreStub = () => ({
  appendThreadMessage: vi.fn(),
  loadThreadMessages: vi.fn().mockReturnValue([]),
  recordRunEvent: vi.fn(),
  saveMemory: vi.fn(),
  recallMemories: vi.fn().mockReturnValue([]),
  close: vi.fn(),
});

describe("agent runtime display streaming", () => {
  beforeEach(() => {
    displayHtmlMock.mockReset();
  });

  it("flushes streamed Display HTML through displayHtml without script tags", async () => {
    const store = createStoreStub();

    await runOrchestratorTurn({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "orchestrator",
      userPrompt: "Show a display",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
      deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
      resolvedLlm,
      store: store as unknown as RuntimeStore,
      displayHtml: displayHtmlMock,
      callbacks: {
        onStream: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
    });

    expect(displayHtmlMock).toHaveBeenCalledWith(
      "<div><p>Hello from Display output</p></div>",
    );
  });
});
