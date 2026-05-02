import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../desktop/src/shared/contracts/agent-runtime.js";
import { createAgentOrchestration } from "../../../../../runtime/kernel/runner/agent-orchestration.js";
import { createSelfModHmrController } from "../../../../../runtime/kernel/self-mod/hmr.js";
import { handleApplyPatch } from "../../../../../runtime/kernel/tools/apply-patch.js";
import {
  createShellState,
  handleExecCommand,
} from "../../../../../runtime/kernel/tools/shell.js";
import type { ToolContext, ToolResult } from "../../../../../runtime/kernel/tools/types.js";

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
    | "shell_alias_write"
    | "running_shell"
    | "parallel_running_shell";
  patch: string;
  root: string;
};

const mockRuntime: MockRuntimeState = {
  mode: "apply_patch" as
    | "apply_patch"
    | "safe_shell"
    | "safe_shell_alias"
    | "real_shell_write"
    | "shell_alias_write"
    | "running_shell"
    | "parallel_running_shell",
  patch: "",
  root: "",
};

const getMockRuntime = (): MockRuntimeState =>
  ((globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
    .__stellaOrchHmrMock ?? mockRuntime);

vi.mock("../../../../../runtime/kernel/agent-runtime.js", () => ({
  shutdownSubagentRuntimes: vi.fn(),
  runSubagentTask: vi.fn(async (opts: {
    toolExecutor: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
    ) => Promise<ToolResult>;
    callbacks?: {
      onToolEnd?: (event: {
        runId: string;
        seq: number;
        toolCallId: string;
        toolName: string;
        resultPreview: string;
        fileChanges?: ToolResult["fileChanges"];
        producedFiles?: ToolResult["producedFiles"];
      }) => void;
    };
  }) => {
    const runtime = getMockRuntime();
    const context: ToolContext = {
      conversationId: "conversation-1",
      deviceId: "device-1",
      requestId: "request-1",
      stellaRoot: runtime.root,
    };
    const result =
      runtime.mode === "apply_patch"
        ? await opts.toolExecutor("apply_patch", { input: runtime.patch }, context)
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
                      parameters: { cmd: "bun run dev --watch desktop/src/a.tsx" },
                    },
                    {
                      recipient_name: "functions.exec_command",
                      parameters: { cmd: "bun run dev --watch desktop/src/b.tsx" },
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
              : runtime.mode === "shell_alias_write"
                ? await opts.toolExecutor(
                    "exec_command",
                    { command: "perl -pi -e s/before/after/ desktop/src/foo.tsx" },
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
  }),
}));

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  delete (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
    .__stellaOrchHmrMock;
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
    resolveOrCreateActiveThread: () => ({ threadId: "thread-1", reused: false }),
    listActiveThreads: () => [],
    saveAgentRecord: vi.fn(),
    getAgentRecord: () => null,
  };
  return {
    stellaRoot: root,
    stellaHome: root,
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
            stellaRoot: root,
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
          return handleExecCommand(
            createShellState(path.join(root, "state")),
            args,
            {
              ...context,
              stellaRoot: root,
            },
          );
        }
        return Promise.resolve({ result: "ok" });
      },
      registerExtensionTools: vi.fn(),
      killAllShells: vi.fn(),
      killShell: vi.fn(),
      killShellsByPort: vi.fn(),
      shutdown: vi.fn(),
    },
    hookEmitter: { emit: vi.fn() },
    paths: {},
    ensureGoogleWorkspaceToolsLoaded: vi.fn(),
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
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
    mockRuntime.patch = [
      "*** Begin Patch",
      "*** Update File: desktop/src/foo.tsx",
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
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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

  it("kills still-running guarded shell sessions and cancels self-mod finalize", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "running_shell";
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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
    expect(context.selfModLifecycle.finalizeRun).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
  });

  it("releases one shell mutation guard for a parallel batch with multiple running sessions", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "parallel_running_shell";
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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
    expect(context.selfModLifecycle.finalizeRun).not.toHaveBeenCalled();
    expect(context.selfModLifecycle.cancelRun).toHaveBeenCalledTimes(1);
  });

  it("does not run mutating shell commands when the shell mutation guard fails", async () => {
    const root = await makeTempRoot();
    mockRuntime.root = root;
    mockRuntime.mode = "running_shell";
    (globalThis as unknown as { __stellaOrchHmrMock?: MockRuntimeState })
      .__stellaOrchHmrMock = mockRuntime;
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
});
