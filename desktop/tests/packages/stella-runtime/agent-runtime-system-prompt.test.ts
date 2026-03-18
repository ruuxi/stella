import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "../../../electron/core/runtime/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../electron/core/runtime/model-routing.js";
import type { RuntimeStore } from "../../../electron/storage/runtime-store.js";

const { capturedSystemPrompts, mockPromptImpl } = vi.hoisted(() => ({
  capturedSystemPrompts: [] as string[],
  mockPromptImpl: vi.fn(),
}));

vi.mock("../../../electron/core/agent/agent", async () => {
  const actual = await vi.importActual<typeof import("../../../electron/core/agent/agent.js")>(
    "../../../electron/core/agent/agent",
  );

  class MockAgent {
    state: {
      messages: unknown[];
      error?: string;
      pendingToolCalls: Set<string>;
      streamMessage: null;
      isStreaming: boolean;
    };

    constructor(opts: { initialState?: { systemPrompt?: string; messages?: unknown[]; error?: string } }) {
      capturedSystemPrompts.push(opts.initialState?.systemPrompt ?? "");
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
} from "../../../electron/core/runtime/agent-runtime.js";

const buildAgentContext = (
  overrides?: Partial<LocalTaskManagerAgentContext>,
): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "dynamic",
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

const createStoreStub = () => ({
  appendThreadMessage: vi.fn(),
  loadThreadMessages: vi.fn().mockReturnValue([]),
  recordRunEvent: vi.fn(),
  saveMemory: vi.fn(),
  recallMemories: vi.fn().mockReturnValue([]),
  close: vi.fn(),
});

const expectedPlatformPrompt = (() => {
  if (process.platform === "win32") {
    return "On Windows, Bash runs in Git Bash. Prefer POSIX commands and /c/... style paths over C:\\ paths when using Bash.";
  }
  if (process.platform === "darwin") {
    return "On macOS, use standard POSIX shell commands and native /Users/... paths when using Bash.";
  }
  return null;
})();

describe("agent runtime platform shell prompt", () => {
  beforeEach(() => {
    capturedSystemPrompts.length = 0;
    mockPromptImpl.mockReset();
    mockPromptImpl.mockImplementation(async (agent: { state: { messages: unknown[] } }) => {
      agent.state.messages = [...agent.state.messages, successAssistantMessage];
    });
  });

  it("appends the current platform shell guidance when the agent uses default shell-capable tools", async () => {
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

    expect(capturedSystemPrompts[0]).toContain("system");
    expect(capturedSystemPrompts[0]).toContain("dynamic");
    if (expectedPlatformPrompt) {
      expect(capturedSystemPrompts[0]).toContain(expectedPlatformPrompt);
    }
  });

  it("appends the current platform shell guidance when Bash is explicitly allowed", async () => {
    const store = createStoreStub();

    await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Solve this task",
      agentContext: buildAgentContext({
        toolsAllowlist: ["Read", "Bash"],
      }),
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

    expect(capturedSystemPrompts[0]).toContain("system");
    expect(capturedSystemPrompts[0]).toContain("dynamic");
    if (expectedPlatformPrompt) {
      expect(capturedSystemPrompts[0]).toContain(expectedPlatformPrompt);
    }
  });

  it("does not append the platform shell guidance when Bash tools are unavailable", async () => {
    const store = createStoreStub();

    await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "general",
      userPrompt: "Solve this task",
      agentContext: buildAgentContext({
        toolsAllowlist: ["Read", "Edit", "Glob"],
      }),
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

    expect(capturedSystemPrompts[0]).toContain("system");
    expect(capturedSystemPrompts[0]).toContain("dynamic");
    if (expectedPlatformPrompt) {
      expect(capturedSystemPrompts[0]).not.toContain(expectedPlatformPrompt);
    }
  });

  it("includes the runtime skill catalog when skills are available", async () => {
    const store = createStoreStub();

    await runOrchestratorTurn({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "orchestrator",
      userPrompt: "Continue the work",
      agentContext: buildAgentContext({
        defaultSkills: ["calendar"],
        skillIds: ["calendar", "music"],
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

    expect(capturedSystemPrompts[0]).toContain("Skills available in this runtime:");
    expect(capturedSystemPrompts[0]).toContain("Default skills: calendar");
    expect(capturedSystemPrompts[0]).toContain("Enabled installed skill IDs: calendar, music");
  });

  it("appends the documentation section for the self_mod agent only", async () => {
    const store = createStoreStub();

    await runSubagentTask({
      conversationId: "conv-1",
      userMessageId: "user-1",
      agentType: "self_mod",
      userPrompt: "Continue the work",
      agentContext: buildAgentContext(),
      toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
      deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
      frontendRoot: "/tmp/stella/desktop",
      resolvedLlm,
      store: store as unknown as RuntimeStore,
      callbacks: { onError: vi.fn(), onEnd: vi.fn() },
    });

    expect(capturedSystemPrompts[0]).toContain("Documentation:");
    expect(capturedSystemPrompts[0]).toContain("read `src/STELLA.md` first");
    expect(capturedSystemPrompts[0]).not.toContain("nearer `STELLA.md`");
  });

  it("does not append the documentation section for the orchestrator", async () => {
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
      frontendRoot: "/tmp/stella/desktop",
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

    expect(capturedSystemPrompts[0]).not.toContain("Documentation:");
  });
});
