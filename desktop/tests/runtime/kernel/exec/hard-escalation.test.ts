import { describe, expect, it } from "vitest";
import { createExecHost } from "../../../../../runtime/kernel/exec/exec-host.js";
import { createExecToolRegistry } from "../../../../../runtime/kernel/tools/registry/registry.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const ctx: ToolContext = {
  conversationId: "c",
  deviceId: "d",
  requestId: "r",
  storageMode: "local",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Exec hard-escalation", () => {
  it(
    "terminates the worker when a sync infinite loop blows past the grace window, and respawns on the next execute",
    async () => {
      const registry = createExecToolRegistry();
      const host = createExecHost({
        registry,
        defaultHardTerminationGraceMs: 200,
      });
      try {
        const runaway = await host.execute({
          summary: "sync infinite loop",
          source: `while (true) {}`,
          context: ctx,
          timeoutMs: 1000,
        });
        expect(runaway.kind).toBe("failed");
        if (runaway.kind === "failed") {
          expect(runaway.message).toMatch(/timed out/i);
        }

        const next = await host.execute({
          summary: "immediate retry after timeout",
          source: `return 7 * 6;`,
          context: ctx,
        });
        expect(next.kind).toBe("completed");
        if (next.kind === "completed") {
          expect(next.value).toBe(42);
        }
      } finally {
        await host.shutdown();
      }
    },
    15_000,
  );

  it(
    "does not deliver tool results from a terminated worker into the next worker",
    async () => {
      const registry = createExecToolRegistry();
      registry.register({
        name: "slowEcho",
        description: "Echoes an id after a delay.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        outputSchema: { type: "string" },
        handler: async (args) => {
          const id =
            args && typeof args === "object" && typeof (args as { id?: unknown }).id === "string"
              ? (args as { id: string }).id
              : "unknown";
          await sleep(id === "old" ? 1_500 : 2_000);
          return id;
        },
      });
      const host = createExecHost({
        registry,
        defaultHardTerminationGraceMs: 100,
      });
      try {
        const first = await host.execute({
          summary: "old worker slow tool",
          source: `return await tools.slowEcho({ id: "old" });`,
          context: ctx,
          timeoutMs: 1_000,
        });
        expect(first.kind).toBe("failed");
        if (first.kind === "failed") {
          expect(first.message).toMatch(/timed out/i);
        }

        const second = await host.execute({
          summary: "new worker slow tool",
          source: `return await tools.slowEcho({ id: "new" });`,
          context: ctx,
        });
        expect(second.kind).toBe("completed");
        if (second.kind === "completed") {
          expect(second.value).toBe("new");
        }
      } finally {
        await host.shutdown();
      }
    },
    15_000,
  );

  it(
    "does not terminate the worker if the cell finishes naturally inside the grace window",
    async () => {
      const registry = createExecToolRegistry();
      const host = createExecHost({
        registry,
        // Big grace so we can confidently observe the "no escalation" case.
        defaultHardTerminationGraceMs: 5_000,
      });
      try {
        // Cell will be soft-failed at 1000ms but actually finishes ~500ms
        // later (well inside the 5s grace), so we should NOT escalate.
        // It also calls store() before the await; that side-effect must
        // survive on the still-alive worker.
        const slow = await host.execute({
          summary: "slow async",
          source: `
            store("postSoft", "intact");
            await new Promise((r) => setTimeout(r, 1500));
            return "done";
          `,
          context: ctx,
          timeoutMs: 1000,
        });
        expect(slow.kind).toBe("failed");
        if (slow.kind === "failed") {
          expect(slow.message).toMatch(/timed out/i);
        }

        // Wait long enough for: (a) the worker to actually finish the cell
        // naturally (~500ms after soft-fail) and (b) confirm we're well past
        // when an aggressive grace would have fired.
        await sleep(1_000);

        // Same worker is alive: store() set during the slow cell is still
        // observable. If escalation had wiped the worker, this would be
        // undefined.
        const probe = await host.execute({
          summary: "load after slow cell",
          source: `return load("postSoft") ?? "wiped";`,
          context: ctx,
        });
        expect(probe.kind).toBe("completed");
        if (probe.kind === "completed") {
          expect(probe.value).toBe("intact");
        }
      } finally {
        await host.shutdown();
      }
    },
    15_000,
  );

  it(
    "preserves already-persisted store/load state when escalation kills the worker",
    async () => {
      const registry = createExecToolRegistry();
      const host = createExecHost({
        registry,
        defaultHardTerminationGraceMs: 200,
      });
      try {
        const stored = await host.execute({
          summary: "store",
          source: `store("k", "preserved"); return "stored";`,
          context: ctx,
        });
        expect(stored.kind).toBe("completed");

        const runaway = await host.execute({
          summary: "runaway",
          source: `while (true) {}`,
          context: ctx,
          timeoutMs: 1000,
        });
        expect(runaway.kind).toBe("failed");

        // Let escalation fire and a fresh worker spin up.
        await sleep(400);

        const probe = await host.execute({
          summary: "load after escalation",
          source: `return load("k") ?? "missing";`,
          context: ctx,
        });
        expect(probe.kind).toBe("completed");
        if (probe.kind === "completed") {
          expect(probe.value).toBe("preserved");
        }
      } finally {
        await host.shutdown();
      }
    },
    15_000,
  );
});
