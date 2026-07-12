import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { createAgentOrchestration } from "../../../../../runtime/kernel/runner/agent-orchestration.js";
import { createSelfModHmrController } from "../../../../../runtime/kernel/self-mod/hmr.js";
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
    | "send_input_then_apply_patch";
  patch: string;
  firstPatch?: string;
  root: string;
  runCount: number;
  onRunStart?: (runCount: number) => void;
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
    | "send_input_then_apply_patch",
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
      if (runtime.mode === "send_input_then_apply_patch" && runCount === 1) {
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
        runtime.mode === "send_input_then_apply_patch"
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

const createTestContext = (root: string, hmrController: unknown) => {
  const runtimeStore = {
    resolveOrCreateActiveThread: () => ({
      threadId: "thread-1",
      reused: false,
    }),
    listActiveThreads: () => [],
    saveAgentRecord: vi.fn(),
    getAgentRecord: () => null,
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
          getMockRuntime().mode === "running_shell"
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
