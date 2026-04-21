import { describe, expect, it } from "vitest";
import { buildExecToolDescription } from "../../../../../runtime/kernel/exec/exec-contract.js";
import {
  createExecHost,
} from "../../../../../runtime/kernel/exec/exec-host.js";
import {
  createExecToolRegistry,
  type ExecToolDefinition,
} from "../../../../../runtime/kernel/tools/registry/registry.js";
import { registerDescribeBuiltin } from "../../../../../runtime/kernel/tools/registry/builtins/index.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const ctx: ToolContext = {
  conversationId: "c",
  deviceId: "d",
  requestId: "r",
  agentType: "general",
  storageMode: "local",
};

const tier1Tool: ExecToolDefinition = {
  name: "core_tool",
  description: "Always-on core tool.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  handler: async (args) => args,
};

const deferredTool: ExecToolDefinition = {
  name: "rare_calendar_op",
  description: "Rare calendar operation that doesn't deserve prompt budget.",
  defer: true,
  inputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "Event identifier." },
    },
    required: ["eventId"],
  },
  handler: async () => ({ ok: true }),
};

describe("deferred tools", () => {
  it("omits deferred tool typed signatures from the Exec description", () => {
    const description = buildExecToolDescription([tier1Tool, deferredTool]);
    // Tier 1 is rendered.
    expect(description).toContain("core_tool(args:");
    // Deferred is NOT rendered as a typed declaration.
    expect(description).not.toContain("rare_calendar_op(args:");
    // Deferred guidance is emitted.
    expect(description).toContain("Deferred tools (1)");
    expect(description).toContain("ALL_TOOLS");
    expect(description).toContain("tools.describe");
  });

  it("does not emit deferred guidance when no tool is deferred", () => {
    const description = buildExecToolDescription([tier1Tool]);
    expect(description).not.toContain("Deferred tools");
  });

  it("makes deferred tools callable through tools.* even though they're hidden in the prompt", async () => {
    const registry = createExecToolRegistry([tier1Tool, deferredTool]);
    registerDescribeBuiltin(registry);
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "call deferred tool",
        source: `
          const ok = await tools.rare_calendar_op({ eventId: "evt-123" });
          return ok;
        `,
        context: ctx,
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.value).toEqual({ ok: true });
    } finally {
      await host.shutdown();
    }
  });

  it("lists every callable tool (including deferred ones) in ALL_TOOLS", async () => {
    const registry = createExecToolRegistry([tier1Tool, deferredTool]);
    registerDescribeBuiltin(registry);
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "inspect ALL_TOOLS",
        source: `
          return ALL_TOOLS.map((t) => t.name).sort();
        `,
        context: ctx,
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.value).toEqual([
        "core_tool",
        "describe",
        "rare_calendar_op",
      ]);
    } finally {
      await host.shutdown();
    }
  });

  it("returns the full schema for a deferred tool via tools.describe", async () => {
    const registry = createExecToolRegistry([tier1Tool, deferredTool]);
    registerDescribeBuiltin(registry);
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "describe deferred",
        source: `
          return await tools.describe({ name: "rare_calendar_op" });
        `,
        context: ctx,
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      const value = result.value as {
        name: string;
        signature: string;
        deferred: boolean;
        inputSchema: Record<string, unknown>;
      };
      expect(value.name).toBe("rare_calendar_op");
      expect(value.deferred).toBe(true);
      expect(value.signature).toContain("tools.rare_calendar_op(args:");
      expect(value.inputSchema).toMatchObject({
        type: "object",
        required: ["eventId"],
      });
    } finally {
      await host.shutdown();
    }
  });

  it("rejects describe for tools the agent isn't allowed to call", async () => {
    const restricted: ExecToolDefinition = {
      name: "orchestrator_only",
      description: "Orchestrator-scoped helper.",
      agentTypes: ["orchestrator"],
      inputSchema: { type: "object", properties: {} },
      handler: async () => null,
    };
    const registry = createExecToolRegistry([tier1Tool, restricted]);
    registerDescribeBuiltin(registry);
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "describe restricted as general",
        source: `
          try {
            await tools.describe({ name: "orchestrator_only" });
            return "should-not-reach";
          } catch (error) {
            return String(error.message);
          }
        `,
        context: { ...ctx, agentType: "general" },
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(String(result.value)).toContain("not available to this agent");
    } finally {
      await host.shutdown();
    }
  });

  it("rejects direct calls to tools the agent isn't allowed to use", async () => {
    const restricted: ExecToolDefinition = {
      name: "orchestrator_only",
      description: "Orchestrator-scoped helper.",
      agentTypes: ["orchestrator"],
      inputSchema: { type: "object", properties: {} },
      handler: async () => "secret",
    };
    const registry = createExecToolRegistry([tier1Tool, restricted]);
    registerDescribeBuiltin(registry);
    const host = createExecHost({ registry });
    try {
      const result = await host.execute({
        summary: "call restricted as general",
        source: `
          try {
            return await tools.orchestrator_only({});
          } catch (error) {
            return String(error.message);
          }
        `,
        context: { ...ctx, agentType: "general" },
      });
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(String(result.value)).toContain("is not a function");
    } finally {
      await host.shutdown();
    }
  });
});
