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

const { runClaudeCodeTurnMock, runCodexAgentTurnMock } = vi.hoisted(() => ({
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
      expect(toolExecutor).toHaveBeenCalledWith(
        "image_gen",
        { prompt: "draw a durable fox" },
        expect.objectContaining({ requestId: "claude-image-call" }),
        undefined,
        undefined,
      );
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
