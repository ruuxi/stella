import { describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { NodeReplKernelRegistry } from "../../../../../runtime/kernel/computer-use/kernel.js";
import { createNodeReplTool } from "../../../../../runtime/kernel/tools/defs/node-repl.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const context: ToolContext = {
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: "request-1",
  agentId: "agent-1",
  agentType: AGENT_IDS.GENERAL,
  stellaAppDir: "/workspace",
  allowedToolNames: [
    "node_repl",
    "multi_tool_use_parallel",
    "fake_tool",
  ],
};

describe("node_repl tool", () => {
  it("is General-only and retains state across tool calls", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({
        request: async () => {
          throw new Error(
            "Unexpected Computer Use request in REPL persistence test.",
          );
        },
      }),
    });
    const tool = createNodeReplTool({ registry });
    try {
      expect(tool.agentTypes).toEqual([AGENT_IDS.GENERAL]);
      expect(tool.description).toContain("bindings persist");
      expect(tool.description).toContain("fresh element IDs");
      await expect(
        tool.execute({ code: "const value = 9" }, context),
      ).resolves.toEqual({
        result: "",
      });
      await expect(
        tool.execute({ code: "value * 2" }, context),
      ).resolves.toEqual({
        result: "18",
      });
    } finally {
      registry.dispose();
    }
  });

  it("exposes allowed tools as a frozen API and runs independent calls concurrently", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (_name, args) => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;
        return { result: args.id };
      },
    });
    const tool = createNodeReplTool({ registry });
    try {
      await expect(
        tool.execute(
          {
            code: `({
              frozen: Object.isFrozen(tools),
              names: Object.keys(tools),
              values: await Promise.all([
                tools.fake_tool({id: 1}),
                tools.fake_tool({id: 2})
              ])
            })`,
          },
          context,
        ),
      ).resolves.toMatchObject({
        result: expect.stringContaining("values: [ 1, 2 ]"),
      });
      const output = await registry.evaluate(
        `({frozen: Object.isFrozen(tools), names: Object.keys(tools)})`,
        context,
      );
      expect(output).toContain("frozen: true");
      expect(output).toContain("fake_tool");
      expect(output).not.toContain("multi_tool_use_parallel");
      expect(output).not.toContain("node_repl");
      expect(maxActiveCalls).toBe(2);

      await expect(
        registry.evaluate("await tools.fake_tool({id: 3})", {
          ...context,
          allowedToolNames: ["node_repl"],
        }),
      ).rejects.toThrow("Invalid or unauthorized tool protocol request");
    } finally {
      await registry.dispose();
    }
  });

  it("drains unawaited nested tools before returning and preserves tracking", async () => {
    let releaseNested!: () => void;
    let markNestedStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => {
      markNestedStarted = resolve;
    });
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const onUpdate = vi.fn();
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (_name, _args, _context, _signal, update) => {
        update?.({ result: "nested update" });
        markNestedStarted();
        await nestedGate;
        return {
          result: "edited",
          fileChanges: [
            { path: "/workspace/app.ts", kind: { type: "update" } },
          ],
          producedFiles: [
            { path: "/workspace/report.pdf", kind: { type: "add" } },
          ],
        };
      },
    });
    const tool = createNodeReplTool({ registry });
    try {
      let completed = false;
      const evaluation = tool
        .execute({ code: `tools.fake_tool({}); "cell complete"` }, context, {
          onUpdate,
        })
        .then((result) => {
          completed = true;
          return result;
        });

      await nestedStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(onUpdate).toHaveBeenCalledWith({
        result: "nested update",
      });

      releaseNested();
      await expect(evaluation).resolves.toEqual({
        result: "'cell complete'",
        fileChanges: [{ path: "/workspace/app.ts", kind: { type: "update" } }],
        producedFiles: [
          { path: "/workspace/report.pdf", kind: { type: "add" } },
        ],
      });
    } finally {
      await registry.dispose();
    }
  });

  it("fails the cell when an unawaited nested tool fails", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("nested tool failed");
      },
    });
    try {
      await expect(
        registry.evaluate(`tools.fake_tool({}); "premature success"`, context),
      ).rejects.toThrow("nested tool failed");
    } finally {
      await registry.dispose();
    }
  });

  it("does not fail the cell when a nested tool failure is caught", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => {
        throw new Error("handled nested failure");
      },
    });
    try {
      await expect(
        registry.evaluate(
          `tools.fake_tool({}).catch(() => {}); "recovered"`,
          context,
        ),
      ).resolves.toBe("'recovered'");
    } finally {
      await registry.dispose();
    }
  });

  it("aborts nested tools when the node_repl evaluation is cancelled", async () => {
    let nestedSignal: AbortSignal | undefined;
    let markNestedStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => {
      markNestedStarted = resolve;
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (_name, _args, _context, signal) => {
        nestedSignal = signal;
        markNestedStarted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
        return { result: "unreachable" };
      },
    });
    try {
      const controller = new AbortController();
      const evaluation = registry.evaluate(
        `tools.fake_tool({}); "must remain pending"`,
        context,
        { signal: controller.signal },
      );
      await nestedStarted;
      controller.abort(new Error("cancel nested tools"));
      await expect(
        evaluation,
      ).rejects.toThrow("cancel nested tools");
      expect(nestedSignal?.aborted).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("fails in bounded time with a diagnosis when an unawaited nested tool never settles, keeping the kernel alive", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      // Never settles: simulates a nested call wedged on a dead transport.
      executeTool: () => new Promise(() => {}),
      toolDrainTimeoutMs: 250,
    });
    try {
      const startedAt = Date.now();
      await expect(
        registry.evaluate(
          `var probe = 41; tools.fake_tool({}); "cell done"`,
          context,
        ),
      ).rejects.toThrow(
        /never settled within 250ms: tools\.fake_tool/,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // The drain timeout must not kill the kernel: REPL state survives.
      await expect(registry.evaluate(`probe + 1`, context)).resolves.toBe(
        "42",
      );
    } finally {
      await registry.dispose();
    }
  });

  it("rejects with the eval timeout instead of hanging when an awaited browser call and its dispose never settle", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      // Wedged bridge: commands and teardown never settle (observed with a
      // hung Brave extension bridge on 2026-07-12).
      browserSessionFactory: () =>
        ({
          command: () => new Promise(() => {}),
          chain: () => new Promise(() => {}),
          dispose: () => new Promise(() => {}),
        }) as never,
      evalTimeoutMs: 300,
      disposeTimeoutMs: 200,
    });
    try {
      const startedAt = Date.now();
      await expect(
        registry.evaluate(`await browser.tabs.list()`, context),
      ).rejects.toThrow("Node REPL timed out after 300ms.");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // The wedged kernel was dropped; a follow-up evaluate gets a fresh
      // kernel instead of queueing behind the dead one.
      await expect(
        registry.evaluate(`1 + 1`, context, { timeoutMs: 2_000 }),
      ).resolves.toBe("2");
    } finally {
      await registry.dispose();
    }
  });

  it("hoists nested tool file tracking onto the node_repl result", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => ({
        result: "edited",
        fileChanges: [{ path: "/workspace/app.ts", kind: { type: "update" } }],
        producedFiles: [{ path: "/workspace/report.pdf", kind: { type: "add" } }],
      }),
    });
    const tool = createNodeReplTool({ registry });
    try {
      await expect(
        tool.execute({ code: `await tools.fake_tool({})` }, context),
      ).resolves.toEqual({
        result: "'edited'",
        fileChanges: [
          { path: "/workspace/app.ts", kind: { type: "update" } },
        ],
        producedFiles: [
          { path: "/workspace/report.pdf", kind: { type: "add" } },
        ],
      });
    } finally {
      await registry.dispose();
    }
  });
});
