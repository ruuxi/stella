import { describe, expect, it } from "vitest";

import { LocalTaskManager } from "../../../../../runtime/kernel/tasks/local-task-manager.js";
import type { ToolContext, ToolResult } from "../../../../../runtime/kernel/tools/types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForTaskCompletion = async (
  manager: LocalTaskManager,
  taskId: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await manager.getTask(taskId);
    if (snapshot && snapshot.status !== "running") {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Task ${taskId} did not finish in time.`);
};

describe("LocalTaskManager Exec fs locking", () => {
  it("serializes mutating Exec calls across concurrent tasks", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const manager = new LocalTaskManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxTaskDepth: 3,
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
      createCloudTaskRecord: async () => ({ taskId: "cloud-unused" }),
      completeCloudTaskRecord: async () => undefined,
      getCloudTaskRecord: async () => null,
      cancelCloudTaskRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createTask({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createTask({
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
