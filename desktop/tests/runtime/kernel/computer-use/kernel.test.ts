import { describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, spawn: childProcessMocks.spawn };
});

import { NodeReplKernelRegistry } from "../../../../../runtime/kernel/computer-use/kernel.js";
import type { ComputerCommandRequest } from "../../../../../runtime/kernel/computer-use/command-runner.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const context = (agentId: string): ToolContext => ({
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: "request-1",
  runId: "run-1",
  agentId,
  agentType: "general",
  stellaAppDir: "/workspace",
  toolWorkspaceRoot: "/workspace/project",
  storageMode: "local",
});

const createRegistry = (idleTimeoutMs = 60_000) =>
  new NodeReplKernelRegistry({
    cliPath: "/runtime/stella-computer.js",
    idleTimeoutMs,
    runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  });

describe("persistent Node REPL kernels", () => {
  it("supports top-level await and preserves lexical bindings", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          [
            "const answer = await Promise.resolve(41)",
            "// Multiline input must remain one REPL evaluation.",
            "answer",
          ].join("\n"),
          context("agent-a"),
        ),
      ).resolves.toBe("41");
      await expect(
        registry.evaluate("answer + 1", context("agent-a")),
      ).resolves.toBe("42");
    } finally {
      registry.dispose();
    }
  });

  it("strictly isolates kernels by the Stella computer session identity", async () => {
    const registry = createRegistry();
    try {
      await registry.evaluate(
        "const ownerSecret = 'alpha'",
        context("agent-a"),
      );
      await expect(
        registry.evaluate("ownerSecret", context("agent-b")),
      ).rejects.toThrow("ownerSecret is not defined");
      await expect(
        registry.evaluate("ownerSecret", context("agent-a")),
      ).resolves.toBe("'alpha'");
    } finally {
      registry.dispose();
    }
  });

  it("serializes evaluations within one kernel", async () => {
    const registry = createRegistry();
    try {
      const first = registry.evaluate(
        "const order = []; await new Promise((resolve) => setTimeout(resolve, 20)); order.push('first')",
        context("agent-a"),
      );
      const second = registry.evaluate(
        "order.push('second'); order",
        context("agent-a"),
      );
      await first;
      await expect(second).resolves.toBe("[ 'first', 'second' ]");
    } finally {
      registry.dispose();
    }
  });

  it("serializes concurrent sky calls and keeps a batch atomic", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const commands: string[] = [];
    let activeCommands = 0;
    let maxActiveCommands = 0;
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      commands.push(String(request.args[3]));
      activeCommands += 1;
      maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
      try {
        if (commands.length === 1) await firstGate;
        return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
      } finally {
        activeCommands -= 1;
      }
    });
    const registry = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      idleTimeoutMs: 60_000,
      runner,
    });
    try {
      const pending = registry.evaluate(
        [
          "await Promise.all([",
          "  sky.batch([",
          "    { type: 'click', app: 'Notes', element_index: 1 },",
          "    { type: 'set_value', app: 'Notes', element_index: 2, value: 'done' },",
          "  ]),",
          "  sky.press_key({ app: 'Notes', key: 'ENTER' }),",
          "])",
        ].join("\n"),
        context("agent-serialized"),
      );

      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
      releaseFirst();
      await pending;

      expect(maxActiveCommands).toBe(1);
      expect(commands).toEqual(["click", "fill", "press"]);
    } finally {
      releaseFirst();
      registry.dispose();
    }
  });

  it("aborts an in-flight sky call without starting queued calls", async () => {
    const controller = new AbortController();
    const runner = vi.fn(
      async (request: ComputerCommandRequest): Promise<ComputerCommandResult> =>
        await new Promise((resolve, reject) => {
          const onAbort = () =>
            reject(
              request.signal?.reason instanceof Error
                ? request.signal.reason
                : new Error("aborted"),
            );
          request.signal?.addEventListener("abort", onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
          void resolve;
        }),
    );
    const registry = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      idleTimeoutMs: 60_000,
      runner,
    });
    try {
      const pending = registry.evaluate(
        "await Promise.all([sky.click({ app: 'Notes', element_index: 1 }), sky.click({ app: 'Notes', element_index: 2 })])",
        context("agent-cancelled"),
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
      controller.abort(new Error("cancel concurrent sky calls"));
      await expect(pending).rejects.toThrow("cancel concurrent sky calls");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      registry.dispose();
    }
  });

  it("exposes frozen metadata and emits file URL screenshots as Stella markers", async () => {
    const registry = createRegistry();
    try {
      const output = await registry.evaluate(
        [
          "nodeRepl.write(nodeRepl.cwd)",
          "nodeRepl.write(nodeRepl.homeDir === nodeRepl.home, nodeRepl.tmpDir === nodeRepl.tmp)",
          "nodeRepl.write(Object.isFrozen(sky))",
          "await nodeRepl.emitImage('file:///tmp/screen%20shot.png')",
        ].join("; "),
        context("agent-a"),
      );
      expect(output).toContain("/workspace/project");
      expect(output).toContain("true true");
      expect(output).toContain(
        `[stella-attach-image] path=${JSON.stringify("/tmp/screen shot.png")}`,
      );
    } finally {
      registry.dispose();
    }
  });

  it("times out async evaluations, drops the kernel, and cleans up idle kernels", async () => {
    const registry = createRegistry(15);
    try {
      await expect(
        registry.evaluate("await new Promise(() => {})", context("agent-a"), {
          timeoutMs: 10,
        }),
      ).rejects.toThrow("timed out");
      await registry.evaluate("const afterTimeout = 1", context("agent-a"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(
        registry.evaluate("afterTimeout", context("agent-a")),
      ).rejects.toThrow("afterTimeout is not defined");
    } finally {
      registry.dispose();
    }
  });

  it("forcibly terminates a synchronous infinite loop without blocking other kernels", async () => {
    const registry = createRegistry();
    try {
      const startedAt = Date.now();
      await expect(
        registry.evaluate("while (true) {}", context("agent-a"), {
          timeoutMs: 50,
        }),
      ).rejects.toThrow("timed out");
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      await expect(
        registry.evaluate("6 * 7", context("agent-b"), { timeoutMs: 1_000 }),
      ).resolves.toBe("42");
      await expect(
        registry.evaluate("typeof answer", context("agent-a"), {
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("'undefined'");
    } finally {
      registry.dispose();
    }
  });

  it("drops a crashed worker and recreates its session kernel", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "setImmediate(() => { throw new Error('intentional worker crash') }); await new Promise(() => {})",
          context("agent-a"),
          { timeoutMs: 1_000 },
        ),
      ).rejects.toThrow("intentional worker crash");
      await expect(
        registry.evaluate("40 + 2", context("agent-a"), {
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("42");
    } finally {
      registry.dispose();
    }
  });

  it("routes the worker's frozen sky client through the scoped CLI runner", async () => {
    const requests: ComputerCommandRequest[] = [];
    const stateOutput = [
      "<app_specific_instructions>",
      "Use Save.",
      "</app_specific_instructions>",
      "<app_state>fresh ids</app_state>",
      `[stella-attach-image] path=${JSON.stringify("/tmp/state image.png")}`,
    ].join("\n");
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      requests.push(request);
      const command = request.args[3];
      if (command === "list-apps") {
        return { exitCode: 0, stdout: "Notes\n", stderr: "" };
      }
      if (command === "get-state") {
        return { exitCode: 0, stdout: stateOutput, stderr: "" };
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
    });
    const registry = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      idleTimeoutMs: 60_000,
      runner,
    });
    try {
      const output = await registry.evaluate(
        [
          "const apps = await sky.list_apps()",
          "const firstState = await sky.get_app_state({ app: 'Notes' })",
          "const secondState = await sky.get_app_state({ app: 'Notes' })",
          "await sky.batch([{ type: 'click', app: 'Notes', element_index: 4 }])",
          "nodeRepl.write(Object.isFrozen(sky), apps, firstState.screenshot.url)",
          "[firstState.text.includes('app_specific_instructions'), secondState.text.includes('app_specific_instructions')]",
        ].join("; "),
        context("agent-a"),
      );

      expect(output).toContain("true Notes file:///tmp/state%20image.png");
      expect(output).toContain("[ true, false ]");
      expect(requests.map((request) => request.args[3])).toEqual([
        "list-apps",
        "get-state",
        "get-state",
        "click",
      ]);
      expect(requests[0]?.args.slice(0, 3)).toEqual([
        "/runtime/stella-computer.js",
        "--session",
        expect.stringContaining("agent-a"),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it("uses the shared executor for multiple production sky calls without spawning the CLI", async () => {
    childProcessMocks.spawn.mockClear();
    const executor = vi.fn(async (argv: string[]) => {
      const command = argv[2];
      if (command === "list-apps") {
        return { exitCode: 0, stdout: "Notes\n", stderr: "" };
      }
      if (command === "get-state") {
        return {
          exitCode: 0,
          stdout: "<app_state>fresh ids</app_state>\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
    });
    const registry = new NodeReplKernelRegistry({
      idleTimeoutMs: 60_000,
      executor,
    });
    try {
      await expect(
        registry.evaluate(
          [
            "await sky.list_apps()",
            "await sky.get_app_state({ app: 'Notes' })",
            "await sky.click({ app: 'Notes', element_index: 2 })",
            "await sky.press_key({ app: 'Notes', key: 'ENTER' })",
          ].join("; "),
          context("agent-direct"),
        ),
      ).resolves.toContain("ok");

      expect(executor).toHaveBeenCalledTimes(4);
      expect(executor.mock.calls.map(([argv]) => argv[2])).toEqual([
        "list-apps",
        "get-state",
        "click",
        "press",
      ]);
      for (const [argv] of executor.mock.calls) {
        expect(argv[0]).toBe("--session");
        expect(argv).not.toContain(process.execPath);
        expect(argv).not.toContain("/runtime/stella-computer.js");
      }
    } finally {
      registry.dispose();
      expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    }
  });

  it("aborts an evaluation and drops its kernel", async () => {
    const registry = createRegistry();
    const controller = new AbortController();
    try {
      const pending = registry.evaluate(
        "const beforeAbort = true; await new Promise(() => {})",
        context("agent-a"),
        { signal: controller.signal },
      );
      controller.abort(new Error("cancelled by test"));
      await expect(pending).rejects.toThrow("cancelled by test");
      await expect(
        registry.evaluate("typeof beforeAbort", context("agent-a")),
      ).resolves.toBe("'undefined'");
    } finally {
      registry.dispose();
    }
  });

  it("keeps fs/path imports but blocks direct process spawning", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "const pathModule = await import('node:path'); pathModule.basename('/a/b')",
          context("agent-a"),
        ),
      ).resolves.toBe("'b'");
      await expect(
        registry.evaluate(
          "await import('node:child_process')",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process spawning is blocked");
    } finally {
      registry.dispose();
    }
  });

  it("blocks computed builtin imports and createRequire process bypasses", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "const child = await import('node:' + 'child_process'); child.spawn('echo', ['unsafe'])",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
      await expect(
        registry.evaluate(
          "const threads = await import('node:' + 'worker_threads'); new threads.Worker('0', { eval: true })",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
      await expect(
        registry.evaluate(
          "const proc = await import('node:' + 'process'); proc.default.getBuiltinModule('child_process')",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
      await expect(
        registry.evaluate(
          [
            "const moduleBuiltin = await import('node:' + 'module')",
            "const computedRequire = moduleBuiltin.createRequire(nodeRepl.cwd + '/node-repl.cjs')",
            "computedRequire('node:' + 'child_process').execFile('echo', ['unsafe'])",
          ].join("; "),
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
    } finally {
      registry.dispose();
    }
  });

  it("derives a resource anchor when no diagnostic CLI path is configured", async () => {
    const requests: ComputerCommandRequest[] = [];
    const registry = new NodeReplKernelRegistry({
      idleTimeoutMs: 60_000,
      runner: vi.fn(async (request: ComputerCommandRequest) => {
        requests.push(request);
        return { exitCode: 0, stdout: "Notes\n", stderr: "" };
      }),
    });
    try {
      await expect(
        registry.evaluate("await sky.list_apps()", context("agent-anchor")),
      ).resolves.toBe("'Notes'");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.args[0]).toMatch(/stella-computer\.js$/);
      expect(requests[0]?.timeoutMs).toBe(30_000);
    } finally {
      registry.dispose();
    }
  });

  it("uses distinct long-lived evaluation, command, and idle defaults", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const requests: ComputerCommandRequest[] = [];
    const registry = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      runner: vi.fn(async (request: ComputerCommandRequest) => {
        requests.push(request);
        return { exitCode: 0, stdout: "Notes\n", stderr: "" };
      }),
    });
    try {
      await registry.evaluate(
        "await sky.list_apps()",
        context("agent-default-budgets"),
      );
      expect(requests[0]?.timeoutMs).toBe(30_000);
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 5 * 60_000),
      ).toBe(true);
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 4 * 60 * 60_000),
      ).toBe(true);
    } finally {
      registry.dispose();
      timeoutSpy.mockRestore();
    }
  });

  it("disposes each kernel session exactly once across closure paths", async () => {
    const explicitCleanup = vi.fn();
    const explicit = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      disposeSession: explicitCleanup,
      idleTimeoutMs: 60_000,
      runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    await explicit.evaluate("1", context("agent-explicit"));
    explicit.dispose();
    explicit.dispose();
    expect(explicitCleanup).toHaveBeenCalledTimes(1);
    expect(explicitCleanup).toHaveBeenCalledWith(
      expect.stringContaining("agent-explicit"),
    );

    const idleCleanup = vi.fn();
    const idle = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      disposeSession: idleCleanup,
      idleTimeoutMs: 10,
      runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    await idle.evaluate("1", context("agent-idle"));
    await vi.waitFor(() => expect(idleCleanup).toHaveBeenCalledTimes(1));
    idle.dispose();
    expect(idleCleanup).toHaveBeenCalledTimes(1);

    const timeoutCleanup = vi.fn();
    const timeout = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      disposeSession: timeoutCleanup,
      idleTimeoutMs: 60_000,
      runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    await expect(
      timeout.evaluate("while (true) {}", context("agent-timeout"), {
        timeoutMs: 20,
      }),
    ).rejects.toThrow("timed out");
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);
    timeout.dispose();
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);

    const failureCleanup = vi.fn();
    const failure = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      disposeSession: failureCleanup,
      idleTimeoutMs: 60_000,
      runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    await expect(
      failure.evaluate(
        "setImmediate(() => { throw new Error('cleanup crash') }); await new Promise(() => {})",
        context("agent-failure"),
      ),
    ).rejects.toThrow("cleanup crash");
    expect(failureCleanup).toHaveBeenCalledTimes(1);
    failure.dispose();
    expect(failureCleanup).toHaveBeenCalledTimes(1);
  });

  it("surfaces thrown non-Error values without waiting for timeout", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate("throw 'plain failure'", context("agent-a")),
      ).rejects.toThrow("plain failure");
    } finally {
      registry.dispose();
    }
  });
});
