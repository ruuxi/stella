import { describe, expect, it } from "vitest";

import { LocalAgentManager } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { AgentLifecycleEvent } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type {
  ToolContext,
  ToolResult,
} from "../../../../../runtime/kernel/tools/types.js";
import { waitForAgentSettled } from "../../../helpers/agent.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("LocalAgentManager Exec fs locking", () => {
  it("emits completed terminal events with the agent result and file changes", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "Cursor finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/cursor-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "cursor task",
      prompt: "do cursor work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-completed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        description: "cursor task",
        result: "Cursor finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/cursor-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
    );
  });

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
        try {
          await sleep(75);
        } finally {
          activeCalls -= 1;
        }
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
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    await expect(manager.getAgent(first.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(manager.getAgent(second.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(maxConcurrentCalls).toBe(1);
  });

  it("serializes native external engine runs through the filesystem lock", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "cursor_sdk",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
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
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(1);
  });

  it("serializes non-general Codex engine runs through the filesystem lock", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "install_update",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "install_update",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(1);
  });
});
