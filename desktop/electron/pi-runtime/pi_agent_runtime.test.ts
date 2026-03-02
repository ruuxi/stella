import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTaskManagerAgentContext } from "./extensions/stella/local_task_manager.js";
import type { JsonlRuntimeStore } from "./jsonl_store.js";

const {
  runCodexAppServerTurnMock,
  runClaudeCodeTurnMock,
  isClaudeCodeModelMock,
} = vi.hoisted(() => ({
  runCodexAppServerTurnMock: vi.fn(),
  runClaudeCodeTurnMock: vi.fn(),
  isClaudeCodeModelMock: vi.fn(),
}));

vi.mock("./extensions/stella/codex_app_server_runtime.js", () => ({
  runCodexAppServerTurn: runCodexAppServerTurnMock,
  shutdownCodexAppServerRuntime: vi.fn(),
}));

vi.mock("./extensions/stella/claude_code_session_runtime.js", () => ({
  isClaudeCodeModel: isClaudeCodeModelMock,
  runClaudeCodeTurn: runClaudeCodeTurnMock,
  shutdownClaudeCodeRuntime: vi.fn(),
}));

import { runPiSubagentTask } from "./pi_agent_runtime.js";

const buildAgentContext = (
  overrides?: Partial<LocalTaskManagerAgentContext>,
): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "",
  model: "openai/gpt-4.1-mini",
  maxTaskDepth: 4,
  defaultSkills: [],
  skillIds: [],
  proxyToken: {
    token: "proxy-token",
    expiresAt: Date.now() + 60_000,
  },
  ...overrides,
});

const buildOpts = (overrides?: Partial<Parameters<typeof runPiSubagentTask>[0]>) => ({
  conversationId: "conv-1",
  userMessageId: "user-1",
  agentType: "general",
  userPrompt: "Solve this task",
  agentContext: buildAgentContext(),
  toolExecutor: vi.fn().mockResolvedValue({ result: "unused" }),
  deviceId: "device-1",
  stellaHome: "/tmp/.stella",
  proxyBaseUrl: "https://proxy.example.com/llm-proxy/v1",
  proxyToken: "proxy-token",
  store: {} as JsonlRuntimeStore,
  ...overrides,
});

describe("runPiSubagentTask engine selection", () => {
  beforeEach(() => {
    runCodexAppServerTurnMock.mockReset();
    runClaudeCodeTurnMock.mockReset();
    isClaudeCodeModelMock.mockReset();
    isClaudeCodeModelMock.mockReturnValue(false);
  });

  it("uses Codex app server when generalAgentEngine is codex_local", async () => {
    runCodexAppServerTurnMock.mockResolvedValue({
      text: "codex-result",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const result = await runPiSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        generalAgentEngine: "codex_local",
        codexLocalMaxConcurrency: 2,
      }),
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("codex-result");
    expect(runCodexAppServerTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexAppServerTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining("conv-1:run:"),
      maxConcurrency: 2,
      prompt: "Solve this task",
    }));
    expect(runClaudeCodeTurnMock).not.toHaveBeenCalled();
  });

  it("uses Claude Code when generalAgentEngine is claude_code_local", async () => {
    runClaudeCodeTurnMock.mockResolvedValue({
      text: "claude-result",
      sessionId: "session-1",
    });

    const result = await runPiSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        generalAgentEngine: "claude_code_local",
      }),
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude-result");
    expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCodeTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "openai/gpt-4.1-mini",
      prompt: "Solve this task",
    }));
    expect(runCodexAppServerTurnMock).not.toHaveBeenCalled();
  });

  it("uses Claude Code when model is claude-code/* for general agent", async () => {
    isClaudeCodeModelMock.mockReturnValue(true);
    runClaudeCodeTurnMock.mockResolvedValue({
      text: "claude-model-result",
      sessionId: "session-2",
    });

    const result = await runPiSubagentTask(buildOpts({
      agentContext: buildAgentContext({
        model: "claude-code/sonnet",
      }),
    }));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude-model-result");
    expect(isClaudeCodeModelMock).toHaveBeenCalledWith("claude-code/sonnet");
    expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexAppServerTurnMock).not.toHaveBeenCalled();
  });
});
