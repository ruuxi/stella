import path from "node:path";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortCursorNodeRunnerProcess,
  buildCursorNodeRunnerSpawnSpec,
  buildCursorAgentOptions,
  buildCursorPromptFromMessages,
  diffCursorWorktreeSnapshots,
  isCursorSdkStreamError,
  parseCursorGitStatus,
  runCursorAgentTurn,
  resolveCursorNodeRunnerPath,
  snapshotCursorWorktree,
  shouldUseCursorAgentRuntime,
  shouldRunCursorSdkInNodeRunner,
  terminateCursorNodeRunnerProcess,
  type CursorWorktreeSnapshot,
  withCursorSdkStreamErrorGuard,
} from "../../../../../runtime/kernel/integrations/cursor-agent-runtime.js";

const execFileAsync = promisify(execFile);
const originalCursorApiKey = process.env.CURSOR_API_KEY;
const originalCursorSdkInProcess = process.env.STELLA_CURSOR_SDK_IN_PROCESS;
const originalCursorSdkNodeBinary = process.env.STELLA_CURSOR_SDK_NODE_BINARY;
const originalHostExecutablePath = process.env.STELLA_HOST_EXECUTABLE_PATH;
const cursorSdkCreate = vi.fn();
const cursorSdkResume = vi.fn();
const cursorSdkSend = vi.fn();

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => cursorSdkCreate(...args),
    resume: (...args: unknown[]) => cursorSdkResume(...args),
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  if (originalCursorApiKey == null) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = originalCursorApiKey;
  }
  if (originalCursorSdkInProcess == null) {
    delete process.env.STELLA_CURSOR_SDK_IN_PROCESS;
  } else {
    process.env.STELLA_CURSOR_SDK_IN_PROCESS = originalCursorSdkInProcess;
  }
  if (originalCursorSdkNodeBinary == null) {
    delete process.env.STELLA_CURSOR_SDK_NODE_BINARY;
  } else {
    process.env.STELLA_CURSOR_SDK_NODE_BINARY = originalCursorSdkNodeBinary;
  }
  if (originalHostExecutablePath == null) {
    delete process.env.STELLA_HOST_EXECUTABLE_PATH;
  } else {
    process.env.STELLA_HOST_EXECUTABLE_PATH = originalHostExecutablePath;
  }
});

const snapshot = (
  status: string,
  fingerprints: Record<string, string | null>,
): CursorWorktreeSnapshot => ({
  repoRoot: "/repo",
  entries: parseCursorGitStatus(status),
  fingerprints: new Map(Object.entries(fingerprints)),
});

const createMockChildProcess = () => {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
};

describe("Cursor agent runtime", () => {
  it("only routes spawned general agents to Cursor", () => {
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "general",
        agentEngine: "cursor_sdk",
      }),
    ).toBe(true);
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "orchestrator",
        agentEngine: "cursor_sdk",
      }),
    ).toBe(false);
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "general",
        agentEngine: "claude_code_local",
      }),
    ).toBe(false);
    expect(
      shouldUseCursorAgentRuntime({
        agentType: "general",
        agentEngine: "default",
        model: "cursor/composer-latest",
      }),
    ).toBe(true);
  });

  it("builds a Cursor prompt from Stella system and ordered prompt messages", () => {
    const prompt = buildCursorPromptFromMessages({
      systemPrompt: "You are Stella.",
      promptMessages: [
        {
          text: "hidden context",
          messageType: "message",
          uiVisibility: "hidden",
          customType: "runtime.test",
        },
        { text: "Do the work." },
      ],
    });

    expect(prompt).toContain("<stella_system_prompt>\nYou are Stella.");
    expect(prompt).toContain(
      '<message index="1" type="message" visibility="hidden" customType="runtime.test">',
    );
    expect(prompt).toContain(
      '<message index="2" type="user" visibility="visible">',
    );
  });

  it("uses documented Cursor local runtime recovery options", () => {
    expect(
      buildCursorAgentOptions({
        apiKey: "cursor-key",
        model: { id: "composer-latest" },
        cwd: "/repo",
      }),
    ).toMatchObject({
      apiKey: "cursor-key",
      model: { id: "composer-latest" },
      local: {
        cwd: "/repo",
        settingSources: [],
        sandboxOptions: { enabled: false },
      },
      platform: { workspaceRef: "/repo" },
    });
  });

  it("forces stale local Cursor runs before sending a new turn", async () => {
    process.env.CURSOR_API_KEY = "cursor-key";
    process.env.STELLA_CURSOR_SDK_IN_PROCESS = "1";
    const run = {
      cancel: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "done" }),
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        };
      },
    };
    const agent = {
      agentId: "agent-id",
      close: vi.fn(),
      send: cursorSdkSend.mockResolvedValue(run),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    cursorSdkCreate.mockResolvedValue(agent);

    await expect(
      runCursorAgentTurn({
        runId: "run-id",
        sessionKey: "session-key",
        prompt: "Do the work.",
        cwd: "/repo",
      }),
    ).resolves.toMatchObject({ sessionId: "agent-id", text: "done" });

    expect(cursorSdkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        local: {
          cwd: "/repo",
          settingSources: [],
          sandboxOptions: { enabled: false },
        },
      }),
    );
    expect(cursorSdkSend).toHaveBeenCalledWith("Do the work.", {
      idempotencyKey: "run-id",
      local: { force: true },
    });
  });

  it("exposes the Cursor agent id before sending a cancellable turn", async () => {
    process.env.CURSOR_API_KEY = "cursor-key";
    process.env.STELLA_CURSOR_SDK_IN_PROCESS = "1";
    const controller = new AbortController();
    const agent = {
      agentId: "agent-resume-target",
      close: vi.fn(),
      send: cursorSdkSend,
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    cursorSdkCreate.mockResolvedValue(agent);
    const observedSessionIds: string[] = [];

    await expect(
      runCursorAgentTurn({
        runId: "run-id",
        sessionKey: "session-key",
        prompt: "Do the work.",
        cwd: "/repo",
        abortSignal: controller.signal,
        onSessionId: (sessionId) => {
          observedSessionIds.push(sessionId);
          controller.abort(new Error("Interrupted by agent input"));
        },
      }),
    ).rejects.toThrow("Aborted");

    expect(observedSessionIds).toEqual(["agent-resume-target"]);
    expect(cursorSdkSend).not.toHaveBeenCalled();
  });

  it("runs the Cursor SDK in a Node runner under Bun unless explicitly disabled", () => {
    expect(shouldRunCursorSdkInNodeRunner()).toBe(
      Boolean((process.versions as { bun?: string }).bun),
    );
    process.env.STELLA_CURSOR_SDK_IN_PROCESS = "1";
    expect(shouldRunCursorSdkInNodeRunner()).toBe(false);
  });

  it("uses Electron as Node for the Cursor SDK runner when the host is Electron", () => {
    delete process.env.STELLA_CURSOR_SDK_NODE_BINARY;
    process.env.STELLA_HOST_EXECUTABLE_PATH =
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";

    expect(buildCursorNodeRunnerSpawnSpec("/runner.js")).toEqual({
      command:
        "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      args: ["/runner.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("prefers PATH node over a non-Electron host executable", () => {
    delete process.env.STELLA_CURSOR_SDK_NODE_BINARY;
    process.env.STELLA_HOST_EXECUTABLE_PATH = "/Applications/Stella.app";

    expect(buildCursorNodeRunnerSpawnSpec("/runner.js")).toEqual({
      command: "node",
      args: ["/runner.js"],
      env: {},
    });
  });

  it("allows an explicit Node binary override for the Cursor SDK runner", () => {
    process.env.STELLA_CURSOR_SDK_NODE_BINARY = "/usr/local/bin/node";
    process.env.STELLA_HOST_EXECUTABLE_PATH = "/Applications/Stella.app";

    expect(buildCursorNodeRunnerSpawnSpec("/runner.js")).toEqual({
      command: "/usr/local/bin/node",
      args: ["/runner.js"],
      env: {},
    });
  });

  it("terminates the Cursor Node runner with SIGTERM and SIGKILL escalation", () => {
    vi.useFakeTimers();
    const child = createMockChildProcess();

    terminateCursorNodeRunnerProcess(child as never);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(3_999);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("aborts the Cursor Node runner with SIGINT before hard termination", () => {
    vi.useFakeTimers();
    const child = createMockChildProcess();

    abortCursorNodeRunnerProcess(child as never);

    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    vi.advanceTimersByTime(1_499);
    expect(child.kill).not.toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(4_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("resolves the Node runner from the bundled worker entry layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-cursor-runner-"));
    try {
      const workerEntry = path.join(root, "runtime", "worker", "entry.js");
      const runner = path.join(
        root,
        "runtime",
        "kernel",
        "integrations",
        "cursor-agent-node-runner.js",
      );
      await mkdir(path.dirname(workerEntry), { recursive: true });
      await mkdir(path.dirname(runner), { recursive: true });
      await writeFile(workerEntry, "", "utf8");
      await writeFile(runner, "", "utf8");

      expect(resolveCursorNodeRunnerPath(workerEntry)).toBe(runner);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes Cursor SDK stream failures that can surface as background rejections", () => {
    expect(
      isCursorSdkStreamError(
        new Error("Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR"),
      ),
    ).toBe(true);
    expect(
      isCursorSdkStreamError(
        Object.assign(new Error("Stream closed"), {
          code: "ERR_HTTP2_STREAM_ERROR",
        }),
      ),
    ).toBe(true);
    expect(isCursorSdkStreamError(new Error("regular failure"))).toBe(false);
  });

  it("suppresses Cursor SDK stream failures emitted as uncaught exceptions", async () => {
    const error = Object.assign(
      new Error("Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR"),
      { code: "ERR_HTTP2_STREAM_ERROR" },
    );

    await expect(
      withCursorSdkStreamErrorGuard(async () => {
        process.emit("uncaughtException", error, "uncaughtException");
        return "ok";
      }),
    ).resolves.toBe("ok");
  });

  it("diffs Cursor-owned worktree changes, including already-dirty files", () => {
    const before = snapshot(" M src/existing.ts\n", {
      "src/existing.ts": "before",
    });
    const after = snapshot(" M src/existing.ts\n?? src/new.ts\n", {
      "src/existing.ts": "after",
      "src/new.ts": "new",
    });

    expect(diffCursorWorktreeSnapshots(before, after)).toEqual([
      {
        path: path.resolve("/repo", "src/existing.ts"),
        kind: { type: "update" },
      },
      {
        path: path.resolve("/repo", "src/new.ts"),
        kind: { type: "add" },
      },
    ]);
  });

  it("snapshots files inside newly-created directories", async () => {
    const repoRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-cursor-snap-"),
    );
    try {
      await execFileAsync("git", ["init"], { cwd: repoRoot });
      await mkdir(path.join(repoRoot, "src", "new-dir"), { recursive: true });
      await writeFile(
        path.join(repoRoot, "src", "new-dir", "created.ts"),
        "export const created = true;\n",
        "utf8",
      );

      const tree = await snapshotCursorWorktree(repoRoot);
      expect(tree?.entries.has("src/new-dir/")).toBe(false);
      expect(tree?.entries.get("src/new-dir/created.ts")).toMatchObject({
        path: "src/new-dir/created.ts",
        status: "??",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves rename destinations from git porcelain status", () => {
    const before = snapshot("", {});
    const after = snapshot("R  src/old.ts -> src/new.ts\n", {
      "src/new.ts": "renamed",
    });

    expect(diffCursorWorktreeSnapshots(before, after)).toEqual([
      {
        path: path.resolve("/repo", "src/old.ts"),
        kind: {
          type: "update",
          move_path: path.resolve("/repo", "src/new.ts"),
        },
      },
    ]);
  });
});
