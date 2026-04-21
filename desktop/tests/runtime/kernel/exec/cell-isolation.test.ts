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

describe("Exec cell isolation", () => {
  it("does not leak globalThis mutations from one cell to the next", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      const first = await host.execute({
        summary: "pollute globals",
        source: `
          globalThis.__leaked_value__ = "from cell 1";
          (globalThis as Record<string, unknown>).__leaked_fn__ = () => "leaked";
          return "polluted";
        `,
        context: ctx,
      });
      expect(first.kind).toBe("completed");

      const second = await host.execute({
        summary: "check globals",
        source: `
          const g = globalThis as Record<string, unknown>;
          return {
            value: g.__leaked_value__ ?? null,
            fn: typeof g.__leaked_fn__,
          };
        `,
        context: ctx,
      });
      expect(second.kind).toBe("completed");
      if (second.kind !== "completed") return;
      expect(second.value).toEqual({ value: null, fn: "undefined" });
    } finally {
      await host.shutdown();
    }
  });

  it("does not leak prototype mutations from one cell to the next", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      const first = await host.execute({
        summary: "pollute prototype",
        source: `
          (Array.prototype as unknown as Record<string, unknown>).__leaked__ =
            function () { return "leaked"; };
          return "polluted";
        `,
        context: ctx,
      });
      expect(first.kind).toBe("completed");

      const second = await host.execute({
        summary: "check prototype",
        source: `
          const arr: unknown[] = [];
          return typeof (arr as unknown as Record<string, unknown>).__leaked__;
        `,
        context: ctx,
      });
      expect(second.kind).toBe("completed");
      if (second.kind !== "completed") return;
      expect(second.value).toBe("undefined");
    } finally {
      await host.shutdown();
    }
  });

  it("keeps store/load working across cells even though globals are reset", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      await host.execute({
        summary: "store",
        source: `
          store("counter", 1);
          store("payload", { name: "stella", n: 42 });
          return "stored";
        `,
        context: ctx,
      });
      const second = await host.execute({
        summary: "load + bump",
        source: `
          const next = (load("counter") as number) + 1;
          store("counter", next);
          return { counter: next, payload: load("payload") };
        `,
        context: ctx,
      });
      expect(second.kind).toBe("completed");
      if (second.kind !== "completed") return;
      expect(second.value).toEqual({
        counter: 2,
        payload: { name: "stella", n: 42 },
      });
    } finally {
      await host.shutdown();
    }
  });

  it("gives each cell a fresh module slot so a returned value can't be observed by the next cell", async () => {
    const registry = createExecToolRegistry();
    const host = createExecHost({ registry });
    try {
      await host.execute({
        summary: "set module-level state",
        source: `
          (globalThis as Record<string, unknown>).module = { exports: "stale" };
          return "set";
        `,
        context: ctx,
      });
      const second = await host.execute({
        summary: "observe module",
        source: `
          const m = (globalThis as Record<string, unknown>).module as
            | { exports: unknown }
            | undefined;
          return m?.exports ?? "absent";
        `,
        context: ctx,
      });
      expect(second.kind).toBe("completed");
      if (second.kind !== "completed") return;
      expect(second.value).toBe("absent");
    } finally {
      await host.shutdown();
    }
  });
});
