import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundCompactionScheduler } from "../../../../../runtime/kernel/agent-runtime/compaction-scheduler.js";
import {
  runExternalOrchestratorTurn,
  runExternalSubagentTurn,
} from "../../../../../runtime/kernel/agent-runtime/external-engines.js";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "../../../../../runtime/kernel/agent-runtime/types.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import type {
  ToolResult,
  ToolUpdateCallback,
} from "../../../../../runtime/kernel/tools/types.js";

const {
  getClaudeCodeErrorFileChangesMock,
  runClaudeCodeTurnMock,
  runCodexAgentTurnMock,
} = vi.hoisted(() => ({
  getClaudeCodeErrorFileChangesMock: vi.fn(() => []),
  runClaudeCodeTurnMock: vi.fn(),
  runCodexAgentTurnMock: vi.fn(),
}));

vi.mock(
  "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../../runtime/kernel/integrations/claude-code-session-runtime.js")
      >();
    return {
      ...actual,
      getClaudeCodeErrorFileChanges: getClaudeCodeErrorFileChangesMock,
      runClaudeCodeTurn: runClaudeCodeTurnMock,
      shutdownClaudeCodeRuntime: vi.fn(),
    };
  },
);

vi.mock(
  "../../../../../runtime/kernel/integrations/codex-agent-runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../../runtime/kernel/integrations/codex-agent-runtime.js")
      >();
    return {
      ...actual,
      runCodexAgentTurn: runCodexAgentTurnMock,
      shutdownCodexAppServerRuntime: vi.fn(),
    };
  },
);

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

const toolCatalog = [
  {
    name: "image_gen",
    description: "Generate an image and return its terminal result.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  },
];

type ExternalToolRequest = {
  vanilla?: boolean;
  sessionKey: string;
  tools: Array<{ name: string }>;
  executeTool: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
};

const withRuntime = async (
  work: (args: {
    dataDir: string;
    store: SessionStore;
    scheduler: BackgroundCompactionScheduler;
  }) => Promise<void>,
): Promise<void> => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-external-image-terminal-"),
  );
  const db = new DatabaseSync(getDesktopDatabasePath(dataDir), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  const scheduler = new BackgroundCompactionScheduler();
  try {
    initializeDesktopDatabase(db);
    await work({ dataDir, store: new SessionStore(db), scheduler });
  } finally {
    await scheduler.drain();
    (db as unknown as { close: () => void }).close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

const makeTerminalResult = (dataDir: string): ToolResult => {
  const artifactPath = path.join(dataDir, "media", "outputs", "job-1_0.png");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const terminal = {
    jobId: "job-1",
    status: "succeeded",
    filePaths: [artifactPath],
    artifacts: [
      {
        kind: "image",
        index: 0,
        path: artifactPath,
        mimeType: "image/png",
        sizeBytes: fs.statSync(artifactPath).size,
      },
    ],
  };
  return { result: terminal, details: terminal };
};

const callbacks = () => ({
  onStream: vi.fn(),
  onToolStart: vi.fn(),
  onToolEnd: vi.fn(),
  onError: vi.fn(),
  onEnd: vi.fn(),
});

describe("external engines receive image_gen terminal results", () => {
  beforeEach(() => {
    runClaudeCodeTurnMock.mockReset();
    runCodexAgentTurnMock.mockReset();
    getClaudeCodeErrorFileChangesMock.mockReset();
    getClaudeCodeErrorFileChangesMock.mockReturnValue([]);
  });

  it("keeps a Claude tool round pending and delivers the final artifact result", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      let releaseTool!: (value: ToolResult) => void;
      const terminalResult = new Promise<ToolResult>((resolve) => {
        releaseTool = resolve;
      });
      let toolStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        toolStarted = resolve;
      });
      let engineSaw: ToolResult | undefined;
      runClaudeCodeTurnMock.mockImplementation(
        async (request: ExternalToolRequest) => {
          const pending = request.executeTool(
            "claude-image-call",
            "image_gen",
            { prompt: "draw a durable fox" },
          );
          toolStarted();
          engineSaw = await pending;
          return {
            text: "The generated image is ready.",
            sessionId: "claude-image-session",
            fileChanges: [],
          };
        },
      );
      const toolExecutor = vi.fn(async () => await terminalResult);
      const opts: OrchestratorRunOptions = {
        runId: "run-claude-image",
        conversationId: "conversation-claude-image",
        userMessageId: "user-claude-image",
        agentType: "orchestrator",
        userPrompt: "Generate an image.",
        agentContext: {
          systemPrompt: "You are Stella's orchestrator.",
          dynamicContext: "",
          maxAgentDepth: 1,
          reasoningEffort: "high",
          agentEngine: "claude_code_local",
          // Even a stray per-spawn selection must never turn the root
          // Orchestrator into vanilla Claude Code.
          spawnEngine: { engine: "claude_code_local", model: "opus" },
          modelConfigSnapshot: {
            engine: "claude_code_local",
            subscriptionHarnessEnabled: true,
            routeModel: "stella/default",
            engineModel: "opus",
          },
          toolsAllowlist: ["image_gen"],
          threadHistory: [],
        },
        toolCatalog,
        toolExecutor,
        deviceId: "device-test",
        stellaDataDir: dataDir,
        stellaAppDir: dataDir,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
        store,
        callbacks: callbacks(),
        compactionScheduler: scheduler,
      };

      let settled = false;
      const run = runExternalOrchestratorTurn(opts).finally(() => {
        settled = true;
      });
      await started;
      expect(settled).toBe(false);
      const finalToolResult = makeTerminalResult(dataDir);
      releaseTool(finalToolResult);

      await expect(run).resolves.toBeTruthy();
      expect(engineSaw).toEqual(finalToolResult);
      expect(runClaudeCodeTurnMock.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: expect.not.stringContaining(":vanilla"),
        tools: [expect.objectContaining({ name: "image_gen" })],
      });
      expect(runClaudeCodeTurnMock.mock.calls[0]?.[0]).not.toHaveProperty(
        "vanilla",
      );
      expect(toolExecutor).toHaveBeenCalledWith(
        "image_gen",
        { prompt: "draw a durable fox" },
        expect.objectContaining({ requestId: "claude-image-call" }),
        undefined,
        undefined,
      );
    }));

  it("runs a globally configured Claude Code General agent in vanilla mode", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      runClaudeCodeTurnMock.mockResolvedValue({
        text: "Vanilla Claude finished the delegated task.",
        sessionId: "claude-general-vanilla-session",
        fileChanges: [],
      });
      const toolExecutor = vi.fn(async () => ({ result: "must not run" }));

      await expect(
        runExternalSubagentTurn({
          runId: "run-claude-general-vanilla",
          rootRunId: "root-claude-general-vanilla",
          conversationId: "conversation-claude-general-vanilla",
          userMessageId: "user-claude-general-vanilla",
          agentType: "general",
          userPrompt: "Complete the delegated task with normal Claude Code.",
          agentContext: {
            systemPrompt: "Stella General system prompt must be ignored.",
            dynamicContext: "",
            maxAgentDepth: 2,
            reasoningEffort: "high",
            agentEngine: "claude_code_local",
            activeThreadId: "claude-general-vanilla-thread",
            toolsAllowlist: ["image_gen"],
            threadHistory: [],
          },
          toolCatalog,
          toolExecutor,
          deviceId: "device-test",
          stellaDataDir: dataDir,
          stellaAppDir: dataDir,
          resolvedLlm: {
            model,
            route: "direct-provider",
            getApiKey: () => undefined,
          },
          store,
          callbacks: callbacks(),
          compactionScheduler: scheduler,
        }),
      ).resolves.toMatchObject({
        result: "Vanilla Claude finished the delegated task.",
      });

      expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
      expect(runClaudeCodeTurnMock.mock.calls[0]?.[0]).toMatchObject({
        vanilla: true,
        sessionKey: expect.stringContaining(":vanilla"),
        tools: [],
      });
      expect(toolExecutor).not.toHaveBeenCalled();
      expect(
        store.getThreadExternalSessionId("claude-general-vanilla-thread"),
      ).toBe("claude_code_local_vanilla:claude-general-vanilla-session");
    }));

  it("runs an opted-in Claude Code General through Stella's takeover harness", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      runClaudeCodeTurnMock.mockResolvedValue({
        text: "Harnessed Claude finished the delegated task.",
        sessionId: "claude-general-harness-session",
        fileChanges: [],
      });

      await expect(
        runExternalSubagentTurn({
          runId: "run-claude-general-harness",
          conversationId: "conversation-claude-general-harness",
          userMessageId: "user-claude-general-harness",
          agentType: "general",
          userPrompt: "Use Stella's managed tools.",
          agentContext: {
            systemPrompt: "Stella General harness prompt.",
            dynamicContext: "",
            maxAgentDepth: 2,
            agentEngine: "claude_code_local",
            activeThreadId: "claude-general-harness-thread",
            modelConfigSnapshot: {
              engine: "claude_code_local",
              subscriptionHarnessEnabled: true,
              routeModel: "stella/default",
              engineModel: "opus",
            },
            toolsAllowlist: ["image_gen"],
            threadHistory: [],
          },
          toolCatalog,
          toolExecutor: async () => ({ result: "unused" }),
          deviceId: "device-test",
          stellaDataDir: dataDir,
          stellaAppDir: dataDir,
          resolvedLlm: {
            model,
            route: "direct-provider",
            getApiKey: () => undefined,
          },
          store,
          callbacks: callbacks(),
          compactionScheduler: scheduler,
        }),
      ).resolves.toMatchObject({
        result: "Harnessed Claude finished the delegated task.",
      });

      expect(runClaudeCodeTurnMock.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: expect.not.stringContaining(":vanilla"),
        tools: [expect.objectContaining({ name: "image_gen" })],
      });
      expect(runClaudeCodeTurnMock.mock.calls[0]?.[0]).not.toHaveProperty(
        "vanilla",
      );
      expect(
        store.getThreadExternalSessionId("claude-general-harness-thread"),
      ).toBe("claude_code_local:claude-general-harness-session");
    }));

  it("surfaces vanilla filesystem writes when a Claude subagent turn fails", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      const failure = new Error("Claude exited after writing");
      const changedPath = path.join(dataDir, "native-after-error.ts");
      runClaudeCodeTurnMock.mockRejectedValue(failure);
      getClaudeCodeErrorFileChangesMock.mockImplementation((error) =>
        error === failure
          ? [{ path: changedPath, kind: { type: "add" as const } }]
          : [],
      );

      const result = await runExternalSubagentTurn({
        runId: "run-claude-general-error-write",
        conversationId: "conversation-claude-general-error-write",
        userMessageId: "user-claude-general-error-write",
        agentType: "general",
        userPrompt: "Write the file.",
        agentContext: {
          systemPrompt: "ignored",
          dynamicContext: "",
          maxAgentDepth: 2,
          agentEngine: "claude_code_local",
          activeThreadId: "claude-general-error-write-thread",
          threadHistory: [],
        },
        toolCatalog: [],
        toolExecutor: async () => ({ result: "unused" }),
        deviceId: "device-test",
        stellaDataDir: dataDir,
        stellaAppDir: dataDir,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
        store,
        callbacks: callbacks(),
        compactionScheduler: scheduler,
      });

      expect(result).toMatchObject({
        error: expect.stringContaining("Claude exited after writing"),
        fileChanges: [{ path: changedPath, kind: { type: "add" } }],
      });
    }));

  it("keeps a Codex tool round pending and delivers the final artifact result", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      let releaseTool!: (value: ToolResult) => void;
      const terminalResult = new Promise<ToolResult>((resolve) => {
        releaseTool = resolve;
      });
      let toolStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        toolStarted = resolve;
      });
      let engineSaw: ToolResult | undefined;
      runCodexAgentTurnMock.mockImplementation(
        async (request: ExternalToolRequest) => {
          const pending = request.executeTool("codex-image-call", "image_gen", {
            prompt: "draw a durable fox",
          });
          toolStarted();
          engineSaw = await pending;
          return {
            text: "The generated image is ready.",
            sessionId: "codex-image-session",
            fileChanges: [],
          };
        },
      );
      const toolExecutor = vi.fn(async () => await terminalResult);
      const opts: SubagentRunOptions = {
        runId: "run-codex-image",
        rootRunId: "root-codex-image",
        conversationId: "conversation-codex-image",
        userMessageId: "user-codex-image",
        agentType: "general",
        userPrompt: "Generate an image.",
        agentContext: {
          systemPrompt: "You are Stella's General agent.",
          dynamicContext: "",
          maxAgentDepth: 1,
          reasoningEffort: "high",
          agentEngine: "codex_cli",
          threadHistory: [],
        },
        toolCatalog,
        toolExecutor,
        deviceId: "device-test",
        stellaDataDir: dataDir,
        stellaAppDir: dataDir,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
        store,
        callbacks: callbacks(),
        compactionScheduler: scheduler,
      };

      let settled = false;
      const run = runExternalSubagentTurn(opts).finally(() => {
        settled = true;
      });
      await started;
      expect(settled).toBe(false);
      const finalToolResult = makeTerminalResult(dataDir);
      releaseTool(finalToolResult);

      await expect(run).resolves.toMatchObject({
        result: "The generated image is ready.",
      });
      expect(engineSaw).toEqual(finalToolResult);
      expect(toolExecutor).toHaveBeenCalledWith(
        "image_gen",
        { prompt: "draw a durable fox" },
        expect.objectContaining({ requestId: "codex-image-call" }),
        undefined,
        undefined,
      );
    }));

  it("bypasses Codex app-server when the durable General snapshot opts into Stella's harness", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      const result = await runExternalSubagentTurn({
        runId: "run-codex-harness",
        conversationId: "conversation-codex-harness",
        userMessageId: "user-codex-harness",
        agentType: "general",
        userPrompt: "Run through the in-process harness.",
        agentContext: {
          systemPrompt: "General",
          dynamicContext: "",
          maxAgentDepth: 2,
          agentEngine: "codex_cli",
          modelConfigSnapshot: {
            engine: "codex_cli",
            subscriptionHarnessEnabled: true,
            routeModel: "openai-codex/gpt-5.6-sol",
            engineModel: "gpt-5.6-sol",
            serviceTier: "fast",
          },
          threadHistory: [],
        },
        toolCatalog,
        toolExecutor: async () => ({ result: "unused" }),
        deviceId: "device-test",
        stellaDataDir: dataDir,
        stellaAppDir: dataDir,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
        store,
        callbacks: callbacks(),
        compactionScheduler: scheduler,
      });

      expect(result).toBeNull();
      expect(runCodexAgentTurnMock).not.toHaveBeenCalled();
    }));

  it("delivers a structured image failure to the Codex continuation", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      let engineSaw: ToolResult | undefined;
      runCodexAgentTurnMock.mockImplementation(
        async (request: ExternalToolRequest) => {
          engineSaw = await request.executeTool(
            "codex-image-failure",
            "image_gen",
            { prompt: "blocked image" },
          );
          return {
            text: "Image failed.",
            sessionId: "codex-failure",
            fileChanges: [],
          };
        },
      );
      const failure: ToolResult = {
        error: "Image request was blocked.",
        details: {
          jobId: "job-blocked",
          status: "failed",
          error: { code: "policy", message: "Image request was blocked." },
        },
      };
      await runExternalSubagentTurn({
        runId: "run-codex-image-failure",
        rootRunId: "root-codex-image-failure",
        conversationId: "conversation-codex-image-failure",
        userMessageId: "user-codex-image-failure",
        agentType: "general",
        userPrompt: "Generate an image.",
        agentContext: {
          systemPrompt: "General",
          dynamicContext: "",
          maxAgentDepth: 1,
          reasoningEffort: "high",
          agentEngine: "codex_cli",
          threadHistory: [],
        },
        toolCatalog,
        toolExecutor: async () => failure,
        deviceId: "device-test",
        stellaDataDir: dataDir,
        stellaAppDir: dataDir,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
        store,
        callbacks: callbacks(),
        compactionScheduler: scheduler,
      });
      expect(engineSaw).toEqual(failure);
    }));

  it("preserves Claude image cancellation without converting it to a retryable tool error", async () =>
    withRuntime(async ({ dataDir, store, scheduler }) => {
      runClaudeCodeTurnMock.mockImplementation(
        async (request: ExternalToolRequest) => {
          const controller = new AbortController();
          const pending = request.executeTool(
            "claude-image-cancel",
            "image_gen",
            { prompt: "cancel image" },
            controller.signal,
          );
          controller.abort(new DOMException("Canceled", "AbortError"));
          await pending;
          return {
            text: "unreachable",
            sessionId: "claude-cancel",
            fileChanges: [],
          };
        },
      );
      const toolExecutor = vi.fn(
        async (
          _name: string,
          _args: Record<string, unknown>,
          _context: unknown,
          signal?: AbortSignal,
        ): Promise<ToolResult> =>
          await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );
      const cancelCallbacks = callbacks();
      await expect(
        runExternalOrchestratorTurn({
          runId: "run-claude-image-cancel",
          conversationId: "conversation-claude-image-cancel",
          userMessageId: "user-claude-image-cancel",
          agentType: "orchestrator",
          userPrompt: "Generate an image.",
          agentContext: {
            systemPrompt: "Orchestrator",
            dynamicContext: "",
            maxAgentDepth: 1,
            reasoningEffort: "high",
            agentEngine: "claude_code_local",
            threadHistory: [],
          },
          toolCatalog,
          toolExecutor: toolExecutor as never,
          deviceId: "device-test",
          stellaDataDir: dataDir,
          stellaAppDir: dataDir,
          resolvedLlm: {
            model,
            route: "direct-provider",
            getApiKey: () => undefined,
          },
          store,
          callbacks: cancelCallbacks,
          compactionScheduler: scheduler,
        }),
      ).resolves.toBe("run-claude-image-cancel");
      expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(1);
      expect(toolExecutor).toHaveBeenCalledTimes(1);
    }));
});
