import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { createAgentOrchestration } from "../../../../../runtime/kernel/runner/agent-orchestration.js";
import { createSelfModHmrController } from "../../../../../runtime/kernel/self-mod/hmr.js";
import type { PersistedAgentRecord } from "../../../../../runtime/kernel/storage/runtime-store.js";
import { handleApplyPatch } from "../../../../../runtime/kernel/tools/apply-patch.js";
import {
  createShellState,
  handleExecCommand,
} from "../../../../../runtime/kernel/tools/shell.js";
import type {
  ToolContext,
  ToolResult,
} from "../../../../../runtime/kernel/tools/types.js";

vi.mock("../../../../../runtime/kernel/model-routing.js", () => ({
  resolveLlmRoute: vi.fn(() => ({
    model: { id: "test-model", provider: "test-provider" },
    route: "direct-provider",
    getApiKey: () => "test-key",
  })),
  resolveLlmRouteForCatalogEnrichment: vi.fn(() => ({
    model: { id: "test-model", provider: "test-provider" },
    route: "direct-provider",
    getApiKey: () => "test-key",
  })),
}));

type MockRuntimeState = {
  mode:
    | "apply_patch"
    | "safe_shell"
    | "safe_shell_alias"
    | "real_shell_write"
    | "shell_suppressed_route_tree"
    | "shell_alias_write"
    | "install_update_merge"
    | "running_shell"
    | "parallel_running_shell"
    | "tool_activity"
    | "interrupted"
    | "interrupt_after_apply_patch"
    | "send_input_then_apply_patch"
    | "pause_resume_self_mod"
    | "hung_takeover_self_mod";
  patch: string;
  firstPatch?: string;
  root: string;
  runCount: number;
  onRunStart?: (runCount: number) => void;
  onFirstWrite?: () => void;
  hungAttemptGate?: Promise<void>;
  onHungResourcesReady?: () => void;
};

const mockRuntime: MockRuntimeState = {
  mode: "apply_patch" as
    | "apply_patch"
    | "safe_shell"
    | "safe_shell_alias"
    | "real_shell_write"
    | "shell_suppressed_route_tree"
    | "shell_alias_write"
    | "install_update_merge"
    | "running_shell"
    | "parallel_running_shell"
    | "tool_activity"
    | "interrupted"
    | "interrupt_after_apply_patch"
    | "send_input_then_apply_patch"
    | "pause_resume_self_mod"
    | "hung_takeover_self_mod",
  patch: "",
  root: "",
  runCount: 0,
};

const getMockRuntime = (): MockRuntimeState =>
  (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
    .__stellaOrchHmrMock ?? mockRuntime;

vi.mock("../../../../../runtime/kernel/agent-runtime.js", () => ({
  shutdownSubagentRuntimes: vi.fn(),
  runSubagentTask: vi.fn(
    async (opts: {
      toolExecutor: (
        toolName: string,
        args: Record<string, unknown>,
        context: ToolContext,
      ) => Promise<ToolResult>;
      callbacks?: {
        onToolStart?: (event: {
          runId: string;
          agentType: string;
          seq: number;
          toolCallId: string;
          toolName: string;
          statusText?: string;
          args: Record<string, unknown>;
        }) => void;
        onToolEnd?: (event: {
          runId: string;
          seq: number;
          toolCallId: string;
          toolName: string;
          resultPreview: string;
          fileChanges?: ToolResult["fileChanges"];
          producedFiles?: ToolResult["producedFiles"];
          details?: unknown;
        }) => void;
      };
      abortSignal?: AbortSignal;
    }) => {
      const runtime = getMockRuntime();
      const runCount = runtime.runCount + 1;
      runtime.runCount = runCount;
      runtime.onRunStart?.(runCount);
      const context: ToolContext = {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        stellaAppDir: runtime.root,
      };
      if (runtime.mode === "tool_activity") {
        opts.callbacks?.onToolStart?.({
          runId: "subagent-run-tool-activity",
          agentType: AGENT_IDS.GENERAL,
          seq: 1,
          toolCallId: "command-1",
          toolName: "exec_command",
          statusText: "Running command",
          args: { command: "API_TOKEN=hidden bun test", cwd: runtime.root },
        });
        opts.callbacks?.onToolEnd?.({
          runId: "subagent-run-tool-activity",
          seq: 2,
          toolCallId: "command-1",
          toolName: "exec_command",
          resultPreview: "completed",
          details: {
            command: "API_TOKEN=hidden bun test",
            cwd: runtime.root,
            state: "completed",
            exitCode: 0,
          },
        });
        return {
          runId: "subagent-run-tool-activity",
          result: "done",
        };
      }
      if (
        (runtime.mode === "send_input_then_apply_patch" ||
          runtime.mode === "pause_resume_self_mod") &&
        runCount === 1
      ) {
        const result = await opts.toolExecutor(
          "apply_patch",
          { input: runtime.firstPatch ?? runtime.patch },
          context,
        );
        opts.callbacks?.onToolEnd?.({
          runId: "subagent-run-1",
          seq: 1,
          toolCallId: "tool-1",
          toolName: "apply_patch",
          resultPreview: result.error ?? "ok",
          fileChanges: result.fileChanges,
          producedFiles: result.producedFiles,
        });
        runtime.onFirstWrite?.();
        await new Promise<void>((resolve) => {
          if (opts.abortSignal?.aborted) {
            resolve();
            return;
          }
          opts.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {
          runId: "subagent-run-1",
          result: "",
          interrupted: true,
        };
      }
      if (runtime.mode === "hung_takeover_self_mod") {
        if (runCount > 1) {
          return {
            runId: `subagent-run-${runCount}`,
            result: "resumed after forced cleanup",
          };
        }
        const patchResult = await opts.toolExecutor(
          "apply_patch",
          { input: runtime.patch },
          context,
        );
        opts.callbacks?.onToolEnd?.({
          runId: "subagent-run-hung",
          seq: 1,
          toolCallId: "tool-write",
          toolName: "apply_patch",
          resultPreview: patchResult.error ?? "ok",
          fileChanges: patchResult.fileChanges,
          producedFiles: patchResult.producedFiles,
        });
        await opts.toolExecutor(
          "exec_command",
          { cmd: "bun run dev --watch desktop/src/foo.tsx" },
          context,
        );
        runtime.onHungResourcesReady?.();
        await (runtime.hungAttemptGate ?? new Promise<never>(() => {}));
        return {
          runId: "subagent-run-hung",
          result: "late abandoned result",
          interrupted: true,
        };
      }
      if (runtime.mode === "interrupted") {
        return {
          runId: "subagent-run",
          result: "",
          interrupted: true,
        };
      }
      if (runtime.mode === "interrupt_after_apply_patch") {
        const result = await opts.toolExecutor(
          "apply_patch",
          { input: runtime.patch },
          context,
        );
        opts.callbacks?.onToolEnd?.({
          runId: "subagent-run",
          seq: 1,
          toolCallId: "tool-1",
          toolName: "apply_patch",
          resultPreview: result.error ?? "ok",
          fileChanges: result.fileChanges,
          producedFiles: result.producedFiles,
        });
        return {
          runId: "subagent-run",
          result: "",
          interrupted: true,
        };
      }

      const result =
        runtime.mode === "apply_patch" ||
        runtime.mode === "send_input_then_apply_patch" ||
        runtime.mode === "pause_resume_self_mod"
          ? await opts.toolExecutor(
              "apply_patch",
              { input: runtime.patch },
              context,
            )
          : runtime.mode === "running_shell"
            ? await opts.toolExecutor(
                "exec_command",
                { cmd: "bun run dev --watch desktop/src/foo.tsx" },
                context,
              )
            : runtime.mode === "parallel_running_shell"
              ? await opts.toolExecutor(
                  "multi_tool_use_parallel",
                  {
                    tool_uses: [
                      {
                        recipient_name: "functions.exec_command",
                        parameters: {
                          cmd: "bun run dev --watch desktop/src/a.tsx",
                        },
                      },
                      {
                        recipient_name: "functions.exec_command",
                        parameters: {
                          cmd: "bun run dev --watch desktop/src/b.tsx",
                        },
                      },
                    ],
                  },
                  context,
                )
              : runtime.mode === "safe_shell_alias"
                ? await opts.toolExecutor(
                    "exec_command",
                    { command: "rg value desktop/src/foo.tsx" },
                    context,
                  )
                : runtime.mode === "real_shell_write"
                  ? await opts.toolExecutor(
                      "exec_command",
                      {
                        cmd: [
                          "node",
                          "-e",
                          JSON.stringify(
                            "const fs = require('fs'); fs.writeFileSync('desktop/src/foo.tsx', \"export const value = 'after';\\n\");",
                          ),
                        ].join(" "),
                      },
                      context,
                    )
                  : runtime.mode === "shell_suppressed_route_tree"
                    ? await opts.toolExecutor(
                        "exec_command",
                        {
                          cmd: "cd desktop && bunx @tanstack/router-cli generate",
                        },
                        context,
                      )
                    : runtime.mode === "shell_alias_write"
                      ? await opts.toolExecutor(
                          "exec_command",
                          {
                            command:
                              "perl -pi -e s/before/after/ desktop/src/foo.tsx",
                          },
                          context,
                        )
                      : runtime.mode === "install_update_merge"
                        ? await opts.toolExecutor(
                            "exec_command",
                            { cmd: "git merge --no-edit -m Update abc123" },
                            context,
                          )
                        : await opts.toolExecutor(
                            "exec_command",
                            { cmd: "rg value desktop/src/foo.tsx" },
                            context,
                          );
      opts.callbacks?.onToolEnd?.({
        runId: "subagent-run",
        seq: 1,
        toolCallId: "tool-1",
        toolName:
          runtime.mode === "apply_patch"
            ? "apply_patch"
            : runtime.mode === "parallel_running_shell"
              ? "multi_tool_use_parallel"
              : "exec_command",
        resultPreview: result.error ?? "ok",
        fileChanges: result.fileChanges,
        producedFiles: result.producedFiles,
      });
      return {
        runId: "subagent-run",
        result: result.error ? "" : "done",
        error: result.error,
        fileChanges: result.fileChanges,
        producedFiles: result.producedFiles,
      };
    },
  ),
}));

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  delete (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
    .__stellaOrchHmrMock;
  mockRuntime.runCount = 0;
  mockRuntime.firstPatch = undefined;
  mockRuntime.onRunStart = undefined;
  mockRuntime.onFirstWrite = undefined;
  mockRuntime.hungAttemptGate = undefined;
  mockRuntime.onHungResourcesReady = undefined;
  vi.clearAllMocks();
});

const makeTempRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-orch-hmr-"));
  tempRoots.push(root);
  return root;
};

const waitForAgentStatus = async (
  manager: { getAgent: (id: string) => Promise<{ status?: string } | null> },
  threadId: string,
) => {
  for (let i = 0; i < 100; i += 1) {
    const snapshot = await manager.getAgent(threadId);
    if (
      snapshot?.status === "completed" ||
      snapshot?.status === "error" ||
      snapshot?.status === "canceled"
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for agent completion.");
};

const waitUntil = async (predicate: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for orchestration condition.");
};

const createTestContext = (root: string, hmrController: unknown) => {
  const agentRecords = new Map<string, PersistedAgentRecord>();
  const runtimeStore = {
    resolveOrCreateActiveThread: () => ({
      threadId: "thread-1",
      reused: false,
    }),
    listActiveThreads: () => [],
    saveAgentRecord: vi.fn((record: PersistedAgentRecord) => {
      agentRecords.set(record.threadId, structuredClone(record));
    }),
    getAgentRecord: (threadId: string) => agentRecords.get(threadId) ?? null,
    listAgentRecordsByStatus: (status: string) =>
      [...agentRecords.values()].filter((record) => record.status === status),
    listAgentRecordsWithPendingCleanup: () =>
      [...agentRecords.values()].filter((record) => record.pendingCleanup),
  };
  return {
    stellaAppDir: root,
    stellaDataDir: root,
    deviceId: "device-1",
    runtimeStore,
    appendLocalChatEvent: vi.fn(),
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map(),
      conversationCallbacks: new Map(),
      convexSiteUrl: null,
      authToken: null,
    },
    selfModHmrController: hmrController,
    selfModLifecycle: {
      beginRun: vi.fn(),
      finalizeRun: vi.fn(),
      cancelRun: vi.fn(),
    },
    toolHost: {
      getToolCatalog: () => [],
      executeTool: (
        toolName: string,
        args: Record<string, unknown>,
        context: ToolContext,
      ) => {
        if (toolName === "apply_patch") {
          return handleApplyPatch(args, {
            ...context,
            stellaAppDir: root,
          });
        }
        if (
          toolName === "exec_command" &&
          (getMockRuntime().mode === "running_shell" ||
            getMockRuntime().mode === "hung_takeover_self_mod")
        ) {
          return Promise.resolve({
            result: "Shell ID: session-1",
            details: { session_id: "session-1", running: true },
          });
        }
        if (
          toolName === "multi_tool_use_parallel" &&
          getMockRuntime().mode === "parallel_running_shell"
        ) {
          return Promise.resolve({
            result: "parallel shells running",
            details: {
              results: [
                {
                  index: 0,
                  tool_name: "exec_command",
                  result: "Shell ID: session-1",
                  details: { session_id: "session-1", running: true },
                },
                {
                  index: 1,
                  tool_name: "exec_command",
                  result: "Shell ID: session-2",
                  details: { session_id: "session-2", running: true },
                },
              ],
            },
          });
        }
        if (
          toolName === "exec_command" &&
          getMockRuntime().mode === "real_shell_write"
        ) {
          return handleExecCommand(createShellState(root), args, {
            ...context,
            stellaAppDir: root,
          });
        }
        return Promise.resolve({ result: "ok" });
      },
      registerExtensionTools: vi.fn(),
      drainCompletedShellProducedFiles: vi.fn(async () => []),
      killAllShells: vi.fn(),
      killShell: vi.fn(),
      killShellsByPort: vi.fn(),
      shutdown: vi.fn(),
    },
    hookEmitter: { emit: vi.fn() },
    paths: {},
  } as any;
};

describe("agent orchestration self-mod HMR tracking", () => {
  it("applies post-apply_patch content, not the pre-write snapshot", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "apply_patch";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    mockRuntime.patch = [
      "*** Begin Patch",
      `*** Update File: ${filePath}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      "*** End Patch",
      "",
    ].join("\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });
    let applyContent = "";
    const context = createTestContext(root, controller);
    context.selfModLifecycle.finalizeRun = vi.fn(({ runId }) => {
      const result = controller.finalize(runId);
      applyContent = result.appliedRuns[0]?.files[0]?.content ?? "";
    });
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "edit file",
      prompt: "edit file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(await readFile(filePath, "utf-8")).toBe(
      "export const value = 'after';\n",
    );
    expect(applyContent).toBe("export const value = 'after';\n");
  });

  it("does not start the shell mutation guard for known read-only exec commands", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "safe_shell";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "read file",
      prompt: "read file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(controller.beginShellMutationGuard).not.toHaveBeenCalled();
    expect(controller.recordWrite).not.toHaveBeenCalled();
  });

  it("treats the exec_command command alias as read-only for HMR inference", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "safe_shell_alias";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "read file",
      prompt: "read file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(controller.beginShellMutationGuard).not.toHaveBeenCalled();
    expect(controller.recordWrite).not.toHaveBeenCalled();
  });

  it("guards a non-safe shell command but records no speculative pre-write paths", async () => {
    // Shell-mentioned tokens are not evidence of a write. The shell mutation
    // guard handles the desktop/src snapshot globally; only real
    // fileChanges/producedFiles (returned by the tool) drive recordWrite.
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "shell_alias_write";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(async () => undefined),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "write file",
      prompt: "write file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.recordWrite).not.toHaveBeenCalled();
  });

  it("records real exec_command filesystem writes from producedFiles", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "real_shell_write";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const callOrder: string[] = [];
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(async () => {
        callOrder.push("record-write");
      }),
      beginShellMutationGuard: vi.fn(async () => {
        callOrder.push("guard-begin");
        return true;
      }),
      endShellMutationGuard: vi.fn(async () => {
        callOrder.push("guard-end");
        return true;
      }),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "write file",
      prompt: "write file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(await readFile(filePath, "utf-8")).toBe(
      "export const value = 'after';\n",
    );
    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.recordWrite).toHaveBeenCalledWith(
      expect.any(String),
      [filePath],
      undefined,
    );
    expect(controller.endShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["guard-begin", "record-write", "guard-end"]);
  });

  it("records suppressed Vite shell updates when producedFiles misses a generated file", async () => {
    const root = await makeTempRoot();
    const routeTreePath = path.join(root, "desktop/src/routeTree.gen.ts");
    await mkdir(path.dirname(routeTreePath), { recursive: true });
    await writeFile(routeTreePath, "export const routeTree = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "shell_suppressed_route_tree";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const callOrder: string[] = [];
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(async () => {
        callOrder.push("record-write");
      }),
      beginShellMutationGuard: vi.fn(async () => {
        callOrder.push("guard-begin");
        return true;
      }),
      endShellMutationGuard: vi.fn(async () => {
        callOrder.push("guard-end");
        return {
          ok: true,
          changedPaths: ["desktop/src/routeTree.gen.ts"],
        };
      }),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "generate route tree",
      prompt: "generate route tree",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.recordWrite).toHaveBeenCalledWith(
      expect.any(String),
      [routeTreePath],
      undefined,
    );
    expect(controller.endShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["guard-begin", "guard-end", "record-write"]);
  });

  it("cancels self-mod HMR instead of finalizing when the subagent is interrupted", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "interrupted";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "edit file",
      prompt: "edit file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "canceled" });
    expect(context.selfModLifecycle.finalizeRun).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
  });

  it("cancels tracked writes instead of finalizing when interruption is terminal", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "interrupt_after_apply_patch";
    mockRuntime.patch = [
      "*** Begin Patch",
      `*** Update File: ${filePath}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      "*** End Patch",
      "",
    ].join("\n");
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });
    const appliedPaths: string[] = [];
    const context = createTestContext(root, controller);
    context.selfModLifecycle.finalizeRun = vi.fn(({ runId }) => {
      const result = controller.finalize(runId);
      appliedPaths.push(...result.appliedRuns.flatMap((run) => run.paths));
    });
    context.selfModLifecycle.cancelRun = vi.fn(async (runId) => {
      const result = await controller.cancel(runId);
      appliedPaths.push(...result.appliedRuns.flatMap((run) => run.paths));
    });
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "edit file",
      prompt: "edit file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "canceled" });
    expect(await readFile(filePath, "utf-8")).toBe(
      "export const value = 'after';\n",
    );
    expect(appliedPaths).toEqual([]);
    expect(context.selfModLifecycle.finalizeRun).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
  });

  it("does not finalize self-mod HMR for the run interrupted by send_input", async () => {
    const root = await makeTempRoot();
    const srcDir = path.join(root, "desktop/src");
    await mkdir(srcDir, { recursive: true });
    const fileNames = ["a.tsx", "b.tsx", "c.tsx", "d.tsx", "e.tsx"];
    await Promise.all(
      fileNames.map((fileName) =>
        writeFile(
          path.join(srcDir, fileName),
          "export const value = 'before';\n",
        ),
      ),
    );
    mockRuntime.root = root;
    mockRuntime.mode = "send_input_then_apply_patch";
    mockRuntime.firstPatch = [
      "*** Begin Patch",
      `*** Update File: ${path.join(srcDir, "a.tsx")}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      `*** Update File: ${path.join(srcDir, "b.tsx")}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      `*** Update File: ${path.join(srcDir, "c.tsx")}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      "*** End Patch",
      "",
    ].join("\n");
    mockRuntime.patch = [
      "*** Begin Patch",
      `*** Update File: ${path.join(srcDir, "d.tsx")}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      `*** Update File: ${path.join(srcDir, "e.tsx")}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'after';",
      "*** End Patch",
      "",
    ].join("\n");
    const firstRunStarted = new Promise<void>((resolve) => {
      mockRuntime.onRunStart = (runCount) => {
        if (runCount === 1) resolve();
      };
    });
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });
    const appliedPaths: string[] = [];
    const context = createTestContext(root, controller);
    context.selfModLifecycle.finalizeRun = vi.fn(({ runId }) => {
      const result = controller.finalize(runId);
      appliedPaths.push(...result.appliedRuns.flatMap((run) => run.paths));
    });
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "edit file",
      prompt: "edit file",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await firstRunStarted;
    await context.state.localAgentManager.sendAgentMessage(
      threadId,
      "finish with the updated requirement",
      "orchestrator",
    );
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    await Promise.all(
      fileNames.map(async (fileName) => {
        await expect(
          readFile(path.join(srcDir, fileName), "utf-8"),
        ).resolves.toBe("export const value = 'after';\n");
      }),
    );
    expect(appliedPaths.sort()).toEqual(
      fileNames.map((fileName) => `desktop/src/${fileName}`).sort(),
    );
    expect(context.selfModLifecycle.cancelRun).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.finalizeRun).toHaveBeenCalledTimes(1);
  });

  it("cancels the paused self-mod run and begins a fresh run on immediate resume", async () => {
    const root = await makeTempRoot();
    const srcDir = path.join(root, "desktop/src");
    await mkdir(srcDir, { recursive: true });
    const firstPath = path.join(srcDir, "paused.tsx");
    const resumedPath = path.join(srcDir, "resumed.tsx");
    await writeFile(firstPath, "export const value = 'before';\n");
    await writeFile(resumedPath, "export const value = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "pause_resume_self_mod";
    mockRuntime.firstPatch = [
      "*** Begin Patch",
      `*** Update File: ${firstPath}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'paused-write';",
      "*** End Patch",
      "",
    ].join("\n");
    mockRuntime.patch = [
      "*** Begin Patch",
      `*** Update File: ${resumedPath}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'resumed-write';",
      "*** End Patch",
      "",
    ].join("\n");
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    let firstWriteDone!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      firstWriteDone = resolve;
    });
    mockRuntime.onFirstWrite = firstWriteDone;

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });
    const appliedPaths: string[] = [];
    const context = createTestContext(root, controller);
    context.selfModLifecycle.beginRun = vi.fn();
    context.selfModLifecycle.cancelRun = vi.fn(async (runId) => {
      const result = await controller.cancel(runId);
      appliedPaths.push(...result.appliedRuns.flatMap((run) => run.paths));
    });
    context.selfModLifecycle.finalizeRun = vi.fn(({ runId }) => {
      const result = controller.finalize(runId);
      appliedPaths.push(...result.appliedRuns.flatMap((run) => run.paths));
    });
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "pause and resume self mod",
      prompt: "apply both stages",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await firstWriteGate;
    await context.state.localAgentManager.cancelAgent(
      threadId,
      "Paused by orchestrator.",
    );
    await context.state.localAgentManager.sendAgentMessage(
      threadId,
      "Resume with a fresh self-mod lifecycle.",
      "orchestrator",
    );
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    const begunRunIds = context.selfModLifecycle.beginRun.mock.calls.map(
      ([args]) => args.runId,
    );
    const canceledRunIds = context.selfModLifecycle.cancelRun.mock.calls.map(
      ([runId]) => runId,
    );
    const finalizedRunIds = context.selfModLifecycle.finalizeRun.mock.calls.map(
      ([args]) => args.runId,
    );
    expect(begunRunIds).toHaveLength(2);
    expect(new Set(begunRunIds).size).toBe(2);
    expect(canceledRunIds).toEqual([begunRunIds[0]]);
    expect(finalizedRunIds).toEqual([begunRunIds[1]]);
    expect(appliedPaths).toEqual(["desktop/src/resumed.tsx"]);
  });

  it("force-releases a hung attempt's self-mod run and shell guard before takeover, exactly once", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "hung_takeover_self_mod";
    mockRuntime.patch = [
      "*** Begin Patch",
      `*** Update File: ${filePath}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'hung-write';",
      "*** End Patch",
      "",
    ].join("\n");
    let releaseHungAttempt!: () => void;
    mockRuntime.hungAttemptGate = new Promise<void>((resolve) => {
      releaseHungAttempt = resolve;
    });
    let resourcesReady!: () => void;
    const resourcesReadyGate = new Promise<void>((resolve) => {
      resourcesReady = resolve;
    });
    mockRuntime.onHungResourcesReady = resourcesReady;
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;

    const runStates = new Map<string, "active" | "canceled" | "finalized">();
    let shellMutationDepth = 0;
    let clientUpdatesPaused = false;
    const controller = {
      beginRun: vi.fn(async (runId: string) => {
        runStates.set(runId, "active");
        clientUpdatesPaused = true;
      }),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => {
        shellMutationDepth += 1;
        return true;
      }),
      endShellMutationGuard: vi.fn(async () => {
        shellMutationDepth -= 1;
        return { ok: true, changedPaths: [] };
      }),
      hasRun: vi.fn((runId: string) => runStates.get(runId) === "active"),
    };
    const context = createTestContext(root, controller);
    context.toolHost.killShell = vi.fn(async () => {});
    context.selfModLifecycle.beginRun = vi.fn();
    context.selfModLifecycle.cancelRun = vi.fn(async (runId: string) => {
      runStates.set(runId, "canceled");
      clientUpdatesPaused = false;
    });
    context.selfModLifecycle.finalizeRun = vi.fn(
      async ({ runId }: { runId: string }) => {
        runStates.set(runId, "finalized");
        clientUpdatesPaused = false;
      },
    );
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
      attemptTeardownTimeoutMs: 20,
      attemptResourceCleanupTimeoutMs: 50,
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "take over hung self mod",
      prompt: "write and start a watcher",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await resourcesReadyGate;
    const oldRunId = context.selfModLifecycle.beginRun.mock.calls[0]?.[0]
      .runId as string;
    expect(runStates.get(oldRunId)).toBe("active");
    expect(shellMutationDepth).toBe(1);
    expect(clientUpdatesPaused).toBe(true);

    await context.state.localAgentManager.cancelAgent(
      threadId,
      "Paused by orchestrator.",
    );
    await context.state.localAgentManager.sendAgentMessage(
      threadId,
      "Resume after releasing the abandoned attempt.",
      "orchestrator",
    );
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({
      status: "completed",
      result: "resumed after forced cleanup",
    });
    expect(runStates.get(oldRunId)).toBe("canceled");
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledWith(oldRunId);
    expect(context.toolHost.killShell).toHaveBeenCalledTimes(1);
    expect(context.toolHost.killShell).toHaveBeenCalledWith("session-1");
    expect(shellMutationDepth).toBe(0);
    expect(clientUpdatesPaused).toBe(false);

    // The abandoned tool eventually returns and runs its original finally.
    // The shared cleanup claims make every close path a no-op on settlement.
    releaseHungAttempt();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
    expect(context.toolHost.killShell).toHaveBeenCalledTimes(1);
    expect(controller.endShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(shellMutationDepth).toBe(0);
    expect(
      await context.state.localAgentManager.getAgent(threadId),
    ).toMatchObject({
      status: "completed",
      result: "resumed after forced cleanup",
    });
  });

  it("persists a loud cleanup-timeout diagnostic and retries held resources until acknowledged", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const value = 'before';\n");
    mockRuntime.root = root;
    mockRuntime.mode = "hung_takeover_self_mod";
    mockRuntime.patch = [
      "*** Begin Patch",
      `*** Update File: ${filePath}`,
      "@@",
      "-export const value = 'before';",
      "+export const value = 'hung-write';",
      "*** End Patch",
      "",
    ].join("\n");
    let releaseHungAttempt!: () => void;
    mockRuntime.hungAttemptGate = new Promise<void>((resolve) => {
      releaseHungAttempt = resolve;
    });
    let resourcesReady!: () => void;
    const resourcesReadyGate = new Promise<void>((resolve) => {
      resourcesReady = resolve;
    });
    mockRuntime.onHungResourcesReady = resourcesReady;
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;

    let shellMutationDepth = 0;
    let endAttempts = 0;
    let endInFlight = 0;
    let maxEndInFlight = 0;
    const runStates = new Map<string, "active" | "canceled" | "finalized">();
    const controller = {
      beginRun: vi.fn(async (runId: string) => {
        runStates.set(runId, "active");
      }),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => {
        shellMutationDepth += 1;
        return true;
      }),
      endShellMutationGuard: vi.fn(async () => {
        endAttempts += 1;
        endInFlight += 1;
        maxEndInFlight = Math.max(maxEndInFlight, endInFlight);
        try {
          if (endAttempts === 1) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return { ok: false, changedPaths: [] };
          }
          shellMutationDepth -= 1;
          return { ok: true, changedPaths: [] };
        } finally {
          endInFlight -= 1;
        }
      }),
      hasRun: vi.fn((runId: string) => runStates.get(runId) === "active"),
    };
    const context = createTestContext(root, controller);
    context.toolHost.killShell = vi.fn(async () => {});
    context.selfModLifecycle.beginRun = vi.fn();
    let cancelAttempts = 0;
    let cancelInFlight = 0;
    let maxCancelInFlight = 0;
    context.selfModLifecycle.cancelRun = vi.fn(async (runId: string) => {
      cancelAttempts += 1;
      cancelInFlight += 1;
      maxCancelInFlight = Math.max(maxCancelInFlight, cancelInFlight);
      try {
        if (cancelAttempts === 1) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error("first cancellation was not acknowledged");
        }
        runStates.set(runId, "canceled");
      } finally {
        cancelInFlight -= 1;
      }
    });
    context.selfModLifecycle.finalizeRun = vi.fn(
      async ({ runId }: { runId: string }) => {
        runStates.set(runId, "finalized");
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
      attemptTeardownTimeoutMs: 10,
      attemptResourceCleanupTimeoutMs: 15,
      attemptResourceCleanupRetryMs: 5,
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-timeout-retry",
      description: "retry timed out cleanup",
      prompt: "write and hold resources",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await resourcesReadyGate;
    const oldRunId = context.selfModLifecycle.beginRun.mock.calls[0]?.[0]
      .runId as string;
    await context.state.localAgentManager.cancelAgent(
      threadId,
      "Paused by orchestrator.",
    );
    await context.state.localAgentManager.sendAgentMessage(
      threadId,
      "Resume while cleanup retries in the background.",
      "orchestrator",
    );
    await waitForAgentStatus(context.state.localAgentManager, threadId);

    expect(
      await context.state.localAgentManager.getAgent(threadId),
    ).toMatchObject({
      status: "completed",
      error: expect.stringContaining("still has resources pending release"),
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("still has resources pending release"),
    );
    expect(
      context.runtimeStore.getAgentRecord(threadId)?.pendingCleanup,
    ).toMatchObject({
      attemptGeneration: 1,
      diagnostic: expect.stringContaining("resources pending release"),
      recordedAt: expect.any(Number),
    });
    expect(
      context.runtimeStore
        .listAgentRecordsWithPendingCleanup()
        .map((record) => record.threadId),
    ).toContain(threadId);
    expect(shellMutationDepth).toBe(1);
    expect(runStates.get(oldRunId)).toBe("active");

    await waitUntil(
      async () =>
        cancelAttempts >= 2 &&
        endAttempts >= 2 &&
        (await context.state.localAgentManager.getAgent(threadId))?.error ==
          null,
    );
    expect(runStates.get(oldRunId)).toBe("canceled");
    expect(shellMutationDepth).toBe(0);
    expect(maxCancelInFlight).toBe(1);
    expect(maxEndInFlight).toBe(1);
    expect(context.toolHost.killShell).toHaveBeenCalledTimes(1);
    expect(
      context.runtimeStore.getAgentRecord(threadId)?.pendingCleanup,
    ).toBeUndefined();

    releaseHungAttempt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelAttempts).toBe(2);
    expect(endAttempts).toBe(2);
    errorSpy.mockRestore();
  });

  it("registers takeover cleanup before a hung self-mod lifecycle acquisition", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "safe_shell";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    let oldHmrAcquired!: () => void;
    const oldHmrAcquiredGate = new Promise<void>((resolve) => {
      oldHmrAcquired = resolve;
    });
    const never = new Promise<never>(() => {});
    const runStates = new Map<string, "active" | "canceled" | "finalized">();
    const controller = {
      beginRun: vi.fn(async (runId: string) => {
        runStates.set(runId, "active");
      }),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => ({
        ok: true,
        changedPaths: [],
      })),
      hasRun: vi.fn((runId: string) => runStates.get(runId) === "active"),
    };
    const context = createTestContext(root, controller);
    let lifecycleBeginCount = 0;
    context.selfModLifecycle.beginRun = vi.fn(async () => {
      lifecycleBeginCount += 1;
      if (lifecycleBeginCount === 1) {
        oldHmrAcquired();
        await never;
      }
    });
    context.selfModLifecycle.cancelRun = vi.fn(async (runId: string) => {
      runStates.set(runId, "canceled");
    });
    context.selfModLifecycle.finalizeRun = vi.fn(
      async ({ runId }: { runId: string }) => {
        runStates.set(runId, "finalized");
      },
    );
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
      attemptTeardownTimeoutMs: 10,
      attemptResourceCleanupTimeoutMs: 30,
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-startup-takeover",
      description: "take over lifecycle startup",
      prompt: "start lifecycle",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await oldHmrAcquiredGate;
    const oldRunId = context.selfModLifecycle.beginRun.mock.calls[0]?.[0]
      .runId as string;
    await context.state.localAgentManager.cancelAgent(
      threadId,
      "Paused by orchestrator.",
    );
    await context.state.localAgentManager.sendAgentMessage(
      threadId,
      "Resume after canceling partial startup ownership.",
      "orchestrator",
    );
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(runStates.get(oldRunId)).toBe("canceled");
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledWith(oldRunId);
    expect(controller.beginRun).toHaveBeenCalledTimes(2);
    expect(context.selfModLifecycle.beginRun).toHaveBeenCalledTimes(2);
    expect(
      (await context.state.localAgentManager.getAgent(threadId))?.error,
    ).toContain("resources pending release");
    context.state.localAgentManager.shutdown();
  });

  it("force-cancels an old lifecycle whose successful finalize never settles", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "safe_shell";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const runStates = new Map<string, "active" | "canceled" | "finalized">();
    const controller = {
      beginRun: vi.fn(async (runId: string) => {
        runStates.set(runId, "active");
      }),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => ({
        ok: true,
        changedPaths: [],
      })),
      hasRun: vi.fn((runId: string) => runStates.get(runId) === "active"),
    };
    const context = createTestContext(root, controller);
    context.selfModLifecycle.beginRun = vi.fn();
    context.selfModLifecycle.cancelRun = vi.fn(async (runId: string) => {
      runStates.set(runId, "canceled");
    });
    let releaseOldFinalize!: () => void;
    const oldFinalizeGate = new Promise<void>((resolve) => {
      releaseOldFinalize = resolve;
    });
    let oldFinalizeStarted!: () => void;
    const oldFinalizeStartedGate = new Promise<void>((resolve) => {
      oldFinalizeStarted = resolve;
    });
    let finalizeCount = 0;
    context.selfModLifecycle.finalizeRun = vi.fn(
      async ({ runId }: { runId: string }) => {
        finalizeCount += 1;
        if (finalizeCount === 1) {
          oldFinalizeStarted();
          await oldFinalizeGate;
          return;
        }
        runStates.set(runId, "finalized");
      },
    );
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
      attemptTeardownTimeoutMs: 10,
      attemptResourceCleanupTimeoutMs: 30,
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-finalize-takeover",
      description: "take over hung finalize",
      prompt: "finish successfully",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await oldFinalizeStartedGate;
    const oldRunId = context.selfModLifecycle.beginRun.mock.calls[0]?.[0]
      .runId as string;
    await context.state.localAgentManager.cancelAgent(
      threadId,
      "Paused by orchestrator.",
    );
    await context.state.localAgentManager.sendAgentMessage(
      threadId,
      "Resume after canceling the hung finalize.",
      "orchestrator",
    );
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(runStates.get(oldRunId)).toBe("canceled");
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledWith(oldRunId);
    expect(context.selfModLifecycle.finalizeRun).toHaveBeenCalledTimes(2);

    releaseOldFinalize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
    expect(runStates.get(oldRunId)).toBe("canceled");
    expect(
      await context.state.localAgentManager.getAgent(threadId),
    ).toMatchObject({ status: "completed" });
  });

  it("kills still-running guarded shell sessions and still finalizes self-mod", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "running_shell";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const releaseOrder: string[] = [];
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => {
        releaseOrder.push("guard-end");
        return true;
      }),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    context.toolHost.killShell = vi.fn(async () => {
      releaseOrder.push("kill-start");
      await Promise.resolve();
      releaseOrder.push("kill-end");
    });
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "start watcher",
      prompt: "start watcher",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await waitForAgentStatus(context.state.localAgentManager, threadId);

    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.endShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(context.toolHost.killShell).toHaveBeenCalledWith("session-1");
    expect(releaseOrder).toEqual(["kill-start", "kill-end", "guard-end"]);
    expect(context.toolHost.killAllShells).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.finalizeRun).toHaveBeenCalledTimes(1);
    expect(context.selfModLifecycle.cancelRun).not.toHaveBeenCalled();
  });

  it("kills parallel guarded shell sessions and still finalizes self-mod", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "parallel_running_shell";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "start watchers",
      prompt: "start watchers",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await waitForAgentStatus(context.state.localAgentManager, threadId);

    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.endShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(context.toolHost.killShell).toHaveBeenCalledTimes(2);
    expect(context.toolHost.killShell).toHaveBeenCalledWith("session-1");
    expect(context.toolHost.killShell).toHaveBeenCalledWith("session-2");
    expect(context.toolHost.killAllShells).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.finalizeRun).toHaveBeenCalledTimes(1);
    expect(context.selfModLifecycle.cancelRun).not.toHaveBeenCalled();
  });

  it("does not run mutating shell commands when the shell mutation guard fails", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "running_shell";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => false),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "start watcher",
      prompt: "start watcher",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "error" });
    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.endShellMutationGuard).not.toHaveBeenCalled();
    expect(context.toolHost.killShell).not.toHaveBeenCalled();
    expect(context.toolHost.killAllShells).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.finalizeRun).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
  });

  it("composes production tool callbacks into task activity and root-run consumers", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "tool_activity";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const context = createTestContext(root, {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => true),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    });
    const rootToolStart = vi.fn();
    const rootToolEnd = vi.fn();
    const rootAgentEvent = vi.fn();
    context.state.runCallbacksByRunId.set("root-tool-activity", {
      onStream: vi.fn(),
      onToolStart: rootToolStart,
      onToolEnd: rootToolEnd,
      onAgentEvent: rootAgentEvent,
      onError: vi.fn(),
      onEnd: vi.fn(),
    });
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "watch command progress",
      prompt: "watch command progress",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-tool-activity",
      storageMode: "local",
    });
    await waitForAgentStatus(context.state.localAgentManager, threadId);

    // Progress ticks are ephemeral decoration: they stream to the run's
    // renderer callbacks but are never persisted as message rows (thread
    // state lives in runtime_agents; persisting every tick grew the
    // message table without bound).
    const streamedProgress = rootAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "agent-progress");
    expect(streamedProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolActivity: expect.objectContaining({
            toolCallId: "command-1",
            state: "started",
            argsHint: expect.stringContaining("API_TOKEN=[REDACTED]"),
          }),
        }),
        expect.objectContaining({
          toolActivity: expect.objectContaining({
            toolCallId: "command-1",
            state: "completed",
            exitCode: 0,
          }),
        }),
      ]),
    );
    const persistedProgress = context.appendLocalChatEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "agent-progress");
    expect(persistedProgress).toEqual([]);
    expect(rootToolStart).toHaveBeenCalledTimes(1);
    expect(rootToolEnd).toHaveBeenCalledTimes(1);
  });

  it("still runs install-update git commands when the shell mutation guard is unavailable", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "install_update_merge";
    (
      globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState }
    ).__stellaOrchHmrMock = mockRuntime;
    const controller = {
      beginRun: vi.fn(),
      recordWrite: vi.fn(),
      beginShellMutationGuard: vi.fn(async () => false),
      endShellMutationGuard: vi.fn(async () => true),
      hasRun: vi.fn(() => true),
    };
    const context = createTestContext(root, controller);
    createAgentOrchestration(context, {
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 1,
      }),
      sendMessage: async () => {},
    });

    const { threadId } = await context.state.localAgentManager.createAgent({
      conversationId: "conversation-1",
      description: "apply update",
      prompt: "apply update",
      agentType: AGENT_IDS.INSTALL_UPDATE,
      storageMode: "local",
      selfModMetadata: {
        mode: "desktop-update",
        expectedChangedFiles: ["desktop/src/update-target.tsx"],
      },
    });
    const snapshot = await waitForAgentStatus(
      context.state.localAgentManager,
      threadId,
    );

    expect(snapshot).toMatchObject({ status: "completed" });
    expect(controller.beginShellMutationGuard).toHaveBeenCalledTimes(1);
    expect(controller.recordWrite).toHaveBeenCalledWith(
      expect.any(String),
      [path.join(root, "desktop/src/update-target.tsx")],
      { captureSnapshot: false },
    );
    expect(controller.endShellMutationGuard).not.toHaveBeenCalled();
    expect(context.toolHost.killShell).not.toHaveBeenCalled();
    expect(context.toolHost.killAllShells).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.finalizeRun).toHaveBeenCalledTimes(1);
    expect(context.selfModLifecycle.cancelRun).not.toHaveBeenCalled();
  });
});
