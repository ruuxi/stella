import { describe, expect, it } from "vitest";

import { LocalAgentManager } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { ToolContext, ToolResult } from "../../../../../runtime/kernel/tools/types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForTaskCompletion = async (
  manager: LocalAgentManager,
  agentId: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await manager.getAgent(agentId);
    if (snapshot && snapshot.status !== "running") {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Task ${agentId} did not finish in time.`);
};

describe("LocalAgentManager Exec fs locking", () => {
  it("serializes mutating Exec calls across concurrent tasks", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        const toolContext: ToolContext = {
          conversationId: args.conversationId,
          deviceId: "device-1",
          requestId: `${args.runId}-req`,
          agentType: args.agentType,
          storageMode: "local",
        };
        await args.toolExecutor(
          "Exec",
          {
            summary: "mutate files",
            source: `await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" });`,
          },
          toolContext,
          args.abortSignal,
        );
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (
        toolName: string,
        _args: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolResult> => {
        expect(toolName).toBe("Exec");
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await sleep(75);
        activeCalls -= 1;
        return { result: "ok" };
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForTaskCompletion(manager, first.threadId),
      waitForTaskCompletion(manager, second.threadId),
    ]);

    expect(maxConcurrentCalls).toBe(1);
  });
});
