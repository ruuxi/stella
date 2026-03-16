import os from "os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "../../../electron/core/runtime/tasks/local-task-manager.js";
import type { ResolvedLlmRoute } from "../../../electron/core/runtime/model-routing.js";
import type { RuntimeStore } from "../../../electron/storage/runtime-store.js";

const {
  runClaudeCodeTurnMock,
  isClaudeCodeModelMock,
} = vi.hoisted(() => ({
  runClaudeCodeTurnMock: vi.fn(),
  isClaudeCodeModelMock: vi.fn(),
}));

vi.mock("../../../electron/core/runtime/integrations/claude-code-session-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../electron/core/runtime/integrations/claude-code-session-runtime.js")>(
    "../../../electron/core/runtime/integrations/claude-code-session-runtime",
  );
  return {
    ...actual,
    isClaudeCodeModel: isClaudeCodeModelMock,
    runClaudeCodeTurn: runClaudeCodeTurnMock,
    shutdownClaudeCodeRuntime: vi.fn(),
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
  frontendRoot: "/mock/project/stella/desktop",
  store: createStoreStub() as unknown as RuntimeStore,
  ...overrides,
});

const generalAgentHome = os.homedir();

describe("runSubagentTask external engine selection", () => {
  beforeEach(() => {
    runClaudeCodeTurnMock.mockReset();
    isClaudeCodeModelMock.mockReset();
    isClaudeCodeModelMock.mockReturnValue(false);
  });

  it("uses Claude Code when agentEngine is claude_code_local", async () => {
    const store = createStoreStub();
    runClaudeCodeTurnMock.mockResolvedValue({
      text: "claude-result",
      sessionId: "session-1",
    });

    const result = await runSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        agentEngine: "claude_code_local",
      }),
      store: store as unknown as RuntimeStore,
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude-result");
    expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "openai/gpt-4.1-mini",
      prompt: "Solve this task",
      systemPrompt: expect.stringContaining("system"),
      cwd: generalAgentHome,
    }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_start" }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_end" }));
    expect(store.appendThreadMessage).toHaveBeenCalledTimes(2);
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
      store: store as unknown as RuntimeStore,
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude-model-result");
    expect(isClaudeCodeModelMock).toHaveBeenCalledWith("claude-code/sonnet");
    expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: generalAgentHome,
      systemPrompt: expect.stringContaining("system"),
    }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_start" }));
    expect(store.recordRunEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_end" }));
    expect(store.appendThreadMessage).toHaveBeenCalledTimes(2);
  });

  it("appends Stella documentation guidance for self_mod local Claude runs", async () => {
    const store = createStoreStub();
    runClaudeCodeTurnMock.mockResolvedValue({
      text: "claude-result",
      sessionId: "session-1",
    });

    await runSubagentTask(buildOpts({
      agentType: "self_mod",
      agentContext: buildAgentContext({
        agentEngine: "claude_code_local",
      }),
      store: store as unknown as RuntimeStore,
    }));

    expect(runClaudeCodeTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Solve this task",
      systemPrompt: expect.stringContaining("read `src/STELLA.md` first"),
      cwd: "/mock/project/stella/desktop",
    }));
  });
});
