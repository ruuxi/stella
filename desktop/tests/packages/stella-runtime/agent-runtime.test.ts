import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "@stella/stella-runtime/tasks";
import type { JsonlRuntimeStore } from "../../../packages/stella-runtime/src/jsonl_store.js";
import type { ResolvedLlmRoute } from "../../../packages/stella-runtime/src/model-routing.js";

const {
  runCodexAppServerTurnMock,
  runClaudeCodeTurnMock,
  isClaudeCodeModelMock,
} = vi.hoisted(() => ({
  runCodexAppServerTurnMock: vi.fn(),
  runClaudeCodeTurnMock: vi.fn(),
  isClaudeCodeModelMock: vi.fn(),
}));

vi.mock("@stella/stella-runtime/integrations", async () => {
  const actual = await vi.importActual<typeof import("@stella/stella-runtime/integrations")>(
    "@stella/stella-runtime/integrations",
  );
  return {
    ...actual,
    runCodexAppServerTurn: runCodexAppServerTurnMock,
    shutdownCodexAppServerRuntime: vi.fn(),
    isClaudeCodeModel: isClaudeCodeModelMock,
    runClaudeCodeTurn: runClaudeCodeTurnMock,
    shutdownClaudeCodeRuntime: vi.fn(),
  };
});

import { runSubagentTask } from "@stella/stella-runtime/agent-runtime";

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

const buildOpts = (overrides?: Partial<Parameters<typeof runSubagentTask>[0]>) => ({
  conversationId: "conv-1",
  userMessageId: "user-1",
  agentType: "general",
  userPrompt: "Solve this task",
  agentContext: buildAgentContext(),
  toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
  deviceId: "device-1",
      stellaHome: "/tmp/stella/.stella",
  resolvedLlm: {
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
  } as ResolvedLlmRoute,
  store: createStoreStub() as unknown as JsonlRuntimeStore,
  ...overrides,
});

describe("runSubagentTask engine selection", () => {
  beforeEach(() => {
    runCodexAppServerTurnMock.mockReset();
    runClaudeCodeTurnMock.mockReset();
    isClaudeCodeModelMock.mockReset();
    isClaudeCodeModelMock.mockReturnValue(false);
  });

  it("uses Codex app server when generalAgentEngine is codex_local", async () => {
    const store = createStoreStub();
    runCodexAppServerTurnMock.mockResolvedValue({
      text: "codex-result",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const result = await runSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        generalAgentEngine: "codex_local",
        codexLocalMaxConcurrency: 2,
      }),
      store: store as unknown as JsonlRuntimeStore,
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("codex-result");
    expect(runCodexAppServerTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexAppServerTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining("conv-1:run:"),
      maxConcurrency: 2,
      prompt: "Solve this task",
    }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_start" }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_end" }));
    expect(store.appendThreadMessage).toHaveBeenCalledTimes(2);
    expect(runClaudeCodeTurnMock).not.toHaveBeenCalled();
  });

  it("uses Claude Code when generalAgentEngine is claude_code_local", async () => {
    const store = createStoreStub();
    runClaudeCodeTurnMock.mockResolvedValue({
      text: "claude-result",
      sessionId: "session-1",
    });

    const result = await runSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        generalAgentEngine: "claude_code_local",
      }),
      store: store as unknown as JsonlRuntimeStore,
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude-result");
    expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "openai/gpt-4.1-mini",
      prompt: "Solve this task",
    }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_start" }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_end" }));
    expect(store.appendThreadMessage).toHaveBeenCalledTimes(2);
    expect(runCodexAppServerTurnMock).not.toHaveBeenCalled();
  });

  it("uses Claude Code when model is claude-code/* for general agent", async () => {
    const store = createStoreStub();
    isClaudeCodeModelMock.mockReturnValue(true);
    runClaudeCodeTurnMock.mockResolvedValue({
      text: "claude-model-result",
      sessionId: "session-2",
    });

    const result = await runSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        model: "claude-code/sonnet",
      }),
      store: store as unknown as JsonlRuntimeStore,
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude-model-result");
    expect(isClaudeCodeModelMock).toHaveBeenCalledWith("claude-code/sonnet");
    expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_start" }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_end" }));
    expect(store.appendThreadMessage).toHaveBeenCalledTimes(2);
    expect(runCodexAppServerTurnMock).not.toHaveBeenCalled();
  });
});
