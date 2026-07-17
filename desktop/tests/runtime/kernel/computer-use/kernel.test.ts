import { describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";

import {
  isBunNodeReplRuntime,
  NodeReplKernelRegistry,
  type ComputerUseSessionFactory,
  type ComputerUseSessionFactoryOptions,
} from "../../../../../runtime/kernel/computer-use/kernel.js";
import type {
  BrowserSessionClient,
  BrowserSessionOptions,
} from "../../../../../runtime/kernel/browser-use/client.js";
import type {
  ComputerUseRequest,
  ComputerUseResponse,
} from "../../../../../runtime/kernel/computer-use/contract.js";
import type {
  ComputerUseSession,
  ComputerUseSessionRequestOptions,
} from "../../../../../runtime/kernel/computer-use/session.js";
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

const responseFor = (request: ComputerUseRequest): ComputerUseResponse => {
  const envelope = {
    schemaVersion: request.schemaVersion,
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    sessionId: request.sessionId,
  };
  switch (request.type) {
    case "list_apps":
      return { ...envelope, type: "list_apps", text: "Notes" };
    case "list_windows":
      return { ...envelope, type: "list_windows", text: "Notes: Main" };
    case "resolve_target":
      return {
        ...envelope,
        type: "target_policy",
        policy: {
          bundleIdentifier: "com.apple.Notes",
          displayName: "Notes",
          decision: "allowed",
          allowPersistentApproval: true,
        },
      };
    case "get_app_state":
      return {
        ...envelope,
        type: "app_state",
        state: {
          app: "Notes",
          text: "<app_state>fresh ids</app_state>",
          screenshot: null,
        },
      };
    case "action":
      return {
        ...envelope,
        type: "action",
        receipt: {
          type: "action",
          action: request.command.action.type,
          target: request.command.target,
          status: "completed",
          deferred: false,
        },
      };
    case "batch":
      return {
        ...envelope,
        type: "batch",
        receipt: {
          type: "batch",
          receipts: request.commands.map((command) => ({
            type: "action",
            action: command.action.type,
            target: command.target,
            status: "completed",
            deferred: false,
          })),
        },
      };
  }
};

const defaultSessionFactory: ComputerUseSessionFactory = () => ({
  request: async (request) => responseFor(request),
});

const createRegistry = (idleTimeoutMs = 60_000) =>
  new NodeReplKernelRegistry({
    sessionFactory: defaultSessionFactory,
    idleTimeoutMs,
  });

describe("persistent Node REPL kernels", () => {
  it("recognizes Bun so production kernels use the external Node transport", () => {
    expect(
      isBunNodeReplRuntime({
        ...process.versions,
        bun: "1.3.14",
      }),
    ).toBe(true);
    expect(isBunNodeReplRuntime({ ...process.versions })).toBe(false);
  });

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
    const requests: ComputerUseRequest[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const request = vi.fn(async (typedRequest: ComputerUseRequest) => {
      requests.push(typedRequest);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        if (requests.length === 1) await firstGate;
        return responseFor(typedRequest);
      } finally {
        activeRequests -= 1;
      }
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request }),
      idleTimeoutMs: 60_000,
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

      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      releaseFirst();
      await pending;

      expect(maxActiveRequests).toBe(1);
      expect(requests.map(({ type }) => type)).toEqual([
        "resolve_target",
        "batch",
        "resolve_target",
        "action",
      ]);
      const batches = requests.filter(
        (candidate) => candidate.type === "batch",
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]?.commands).toHaveLength(2);
    } finally {
      releaseFirst();
      registry.dispose();
    }
  });

  it("exposes one persistent browser client with reusable tabs and locators", async () => {
    const command = vi.fn(
      async (action: string, params: Record<string, unknown> = {}) => {
        const data =
          action === "tab_new"
            ? { tabId: 101, index: 0, total: 1 }
            : action === "title"
              ? { title: "Saved profile" }
              : { action, params };
        return {
          sessionId: "agent-browser",
          bridgeSessionId: "stella-app-bridge",
          requestId: `request-${command.mock.calls.length}`,
          action,
          params,
          result: { id: "response", success: true as const, data },
          attempts: 1,
          durationMs: 1,
        };
      },
    );
    const dispose = vi.fn(async () => undefined);
    const browserClient = {
      command,
      chain: vi.fn(),
      dispose,
    } as unknown as BrowserSessionClient;
    const browserOptions: BrowserSessionOptions[] = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      browserBinPath: "/runtime/stella-browser.js",
      idleTimeoutMs: 60_000,
      browserSessionFactory: (options) => {
        browserOptions.push(options);
        return browserClient;
      },
    });

    try {
      await expect(
        registry.evaluate(
          [
            "const tab = await browser.tabs.new('https://example.com/profile')",
            "const nameInput = tab.playwright.getByLabel('Name')",
            "await nameInput.fill('Rahul')",
            "await tab.playwright.getByRole('button', { name: 'Save' }).click()",
            "tab.id",
          ].join("; "),
          context("agent-browser"),
        ),
      ).resolves.toContain("101\n[browser-receipt] calls=3 mutated=true");
      await expect(
        registry.evaluate("await tab.title()", context("agent-browser")),
      ).resolves.toContain(
        "'Saved profile'\n[browser-receipt] calls=1 mutated=false last=title",
      );

      expect(browserOptions).toHaveLength(1);
      expect(browserOptions[0]).toMatchObject({
        binaryPath: "/runtime/stella-browser.js",
        cwd: "/workspace/project",
        ownerLeaseId: expect.any(String),
        ownerLeaseIssuedAt: expect.any(Number),
      });
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "tab_new",
        "fill",
        "click",
        "tab_list",
        "title",
      ]);
      expect(command.mock.calls[1]?.[1]).toMatchObject({
        tabId: 101,
        selector: expect.stringContaining("aria="),
        value: "Rahul",
      });
      expect(command.mock.calls[2]?.[1]).toMatchObject({
        tabId: 101,
        selector: expect.stringContaining("aria="),
      });
    } finally {
      await registry.dispose();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser session alive after a recoverable REPL syntax error", async () => {
    const command = vi.fn(async (action: string) => ({
      sessionId: "syntax-owner",
      bridgeSessionId: "bridge",
      requestId: `request-${command.mock.calls.length}`,
      action,
      params: {},
      result: {
        id: "response",
        success: true as const,
        data:
          action === "tab_new"
            ? { tabId: 91, index: 0, total: 1 }
            : {
                tabs: [{ tabId: 91, url: "about:blank", active: true }],
                activeTabId: 91,
              },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const dispose = vi.fn(async () => undefined);
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({ command, chain: vi.fn(), dispose }) as unknown as BrowserSessionClient,
    });

    try {
      await registry.evaluate(
        "const syntaxTabs = [await browser.tabs.new()]",
        context("syntax-owner"),
      );
      await expect(
        registry.evaluate("const syntaxTabs = []", context("syntax-owner")),
      ).rejects.toThrow("Identifier 'syntaxTabs' has already been declared");
      await expect(
        registry.evaluate(
          "(await browser.tabs.list()).map(tab => tab.id)",
          context("syntax-owner"),
        ),
      ).resolves.toContain("91");
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("offers extension connection once and retries the direct browser call", async () => {
    const command = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Extension not connected. Install the Stella Browser Bridge extension and connect it.",
        ),
      )
      .mockResolvedValueOnce({
        sessionId: "agent-connect",
        bridgeSessionId: "stella-app-bridge",
        requestId: "request-2",
        action: "tab_list",
        params: {},
        result: {
          id: "response-2",
          success: true,
          data: { tabs: [], activeTabId: null },
        },
        attempts: 1,
        durationMs: 1,
      });
    const requestBrowserExtensionConnect = vi.fn(async () => ({
      ok: true as const,
      status: "connected" as const,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      requestBrowserExtensionConnect,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });

    try {
      await expect(
        registry.evaluate(
          "await browser.tabs.list()",
          context("agent-connect"),
        ),
      ).resolves.toContain("[browser-receipt]");
      expect(command).toHaveBeenCalledTimes(2);
      expect(requestBrowserExtensionConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-1",
          agentId: "agent-connect",
          command: "stella-browser node_repl",
        }),
        expect.any(AbortSignal),
      );
    } finally {
      await registry.dispose();
    }
  });

  it("captures one settled receipt and one screenshot after a mutating cell", async () => {
    const jpeg = Buffer.from("real-browser-image-bytes");
    const command = vi.fn(async (action: string) => {
      const data =
        action === "tab_list"
          ? {
              tabs: [
                {
                  tabId: 44,
                  title: "Receipt",
                  url: "https://example.test",
                  active: true,
                },
              ],
              activeTabId: 44,
            }
          : action === "screenshot"
            ? { base64: jpeg.toString("base64"), format: "jpeg" }
            : { ok: true };
      return {
        sessionId: "agent-receipt",
        bridgeSessionId: "stella-app-bridge",
        requestId: `request-${command.mock.calls.length}`,
        action,
        params: {},
        result: { id: "response", success: true as const, data },
        attempts: 1,
        durationMs: 1,
      };
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    let screenshotPath: string | undefined;

    try {
      const output = await registry.evaluate(
        [
          "const receiptTab = browser.tabs.get(44)",
          "await receiptTab.playwright.getByRole('button', { name: 'Save' }).click()",
          "await receiptTab.playwright.getByLabel('Name').fill('Rahul')",
          "'done'",
        ].join("; "),
        context("agent-receipt"),
      );
      expect(output).toContain(
        "[browser-receipt] calls=2 mutated=true tabs=1 activeTabId=44 last=fill",
      );
      expect(output.match(/\[stella-attach-image\][^\n]+/g)).toHaveLength(1);
      const pathMatch = output.match(/path=("[^"\n]+")/);
      expect(pathMatch?.[1]).toBeTruthy();
      screenshotPath = JSON.parse(pathMatch![1]!);
      await expect(readFile(screenshotPath!)).resolves.toEqual(jpeg);
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "click",
        "fill",
        "tab_list",
        "screenshot",
      ]);
    } finally {
      await registry.dispose();
      if (screenshotPath) {
        await expect(readFile(screenshotPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await rm(screenshotPath, { force: true });
      }
    }
  });

  it("aborts an in-flight sky call without starting queued calls", async () => {
    const controller = new AbortController();
    const request = vi.fn(
      async (
        _request: ComputerUseRequest,
        options?: ComputerUseSessionRequestOptions,
      ): Promise<unknown> =>
        await new Promise((_resolve, reject) => {
          const onAbort = () =>
            reject(
              options?.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("aborted"),
            );
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          if (options?.signal?.aborted) onAbort();
        }),
    );
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request }),
      idleTimeoutMs: 60_000,
    });
    try {
      const pending = registry.evaluate(
        "await Promise.all([sky.click({ app: 'Notes', element_index: 1 }), sky.click({ app: 'Notes', element_index: 2 })])",
        context("agent-cancelled"),
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      controller.abort(new Error("cancel concurrent sky calls"));
      await expect(pending).rejects.toThrow("cancel concurrent sky calls");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(request).toHaveBeenCalledTimes(1);
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

  it("routes the frozen sky client through one persistent typed session", async () => {
    const requests: ComputerUseRequest[] = [];
    const factoryOptions: ComputerUseSessionFactoryOptions[] = [];
    const sessionFactory = vi.fn(
      (options: ComputerUseSessionFactoryOptions): ComputerUseSession => {
        factoryOptions.push(options);
        return {
          request: async (request) => {
            requests.push(request);
            if (request.type === "get_app_state") {
              const response = responseFor(request);
              if (response.type !== "app_state") return response;
              return {
                ...response,
                state: {
                  ...response.state,
                  instructions: "Use Save.",
                  screenshot: {
                    type: "image" as const,
                    url: "file:///tmp/state%20image.png",
                  },
                },
              };
            }
            return responseFor(request);
          },
        };
      },
    );
    const authorizeApp = vi.fn(async () => true);
    const registry = new NodeReplKernelRegistry({
      sessionFactory,
      authorizeApp,
      idleTimeoutMs: 60_000,
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
      expect(requests.map(({ type }) => type)).toEqual([
        "list_apps",
        "resolve_target",
        "get_app_state",
        "resolve_target",
        "get_app_state",
        "resolve_target",
        "batch",
      ]);
      const batches = requests.filter((request) => request.type === "batch");
      expect(batches).toHaveLength(1);
      expect(batches[0]?.commands).toHaveLength(1);
      expect(authorizeApp).toHaveBeenCalledTimes(1);
      expect(sessionFactory).toHaveBeenCalledTimes(1);
      expect(factoryOptions[0]).toMatchObject({
        sessionId: expect.stringContaining("agent-a"),
        cwd: "/workspace/project",
        timeoutMs: 30_000,
        getSignal: expect.any(Function),
      });

      await expect(
        registry.evaluate("await sky.list_apps()", context("agent-a")),
      ).resolves.toBe("'Notes'");
      expect(sessionFactory).toHaveBeenCalledTimes(1);
    } finally {
      await registry.dispose();
    }
  });

  it("fails clearly when no typed session factory is configured", async () => {
    const registry = new NodeReplKernelRegistry();
    await expect(
      registry.evaluate("1", context("agent-no-session")),
    ).rejects.toThrow("requires a typed ComputerUseSession factory");
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

  it("uses distinct long-lived evaluation, session, and idle defaults", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const factoryOptions: ComputerUseSessionFactoryOptions[] = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: (options) => {
        factoryOptions.push(options);
        return defaultSessionFactory(options);
      },
    });
    try {
      await registry.evaluate(
        "await sky.list_apps()",
        context("agent-default-budgets"),
      );
      expect(factoryOptions[0]?.timeoutMs).toBe(30_000);
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
      sessionFactory: defaultSessionFactory,
      disposeSession: explicitCleanup,
      idleTimeoutMs: 60_000,
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
      sessionFactory: defaultSessionFactory,
      disposeSession: idleCleanup,
      idleTimeoutMs: 10,
    });
    await idle.evaluate("1", context("agent-idle"));
    await vi.waitFor(() => expect(idleCleanup).toHaveBeenCalledTimes(1));
    idle.dispose();
    expect(idleCleanup).toHaveBeenCalledTimes(1);

    const timeoutCleanup = vi.fn();
    const timeout = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      disposeSession: timeoutCleanup,
      idleTimeoutMs: 60_000,
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
      sessionFactory: defaultSessionFactory,
      disposeSession: failureCleanup,
      idleTimeoutMs: 60_000,
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
