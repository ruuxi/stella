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
};

describe("node_repl tool", () => {
  it("is General-only and retains state across tool calls", async () => {
    const registry = new NodeReplKernelRegistry({
      cliPath: "/runtime/stella-computer.js",
      runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
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
});
