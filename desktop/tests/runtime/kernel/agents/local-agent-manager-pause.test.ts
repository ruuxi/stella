import { describe, expect, it } from "vitest";

import {
  LocalAgentManager,
  AGENT_PAUSE_CANCEL_REASON,
  type AgentLifecycleEvent,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { ToolResult } from "../../../../../runtime/kernel/tools/types.js";

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

describe("LocalAgentManager pause_agent cancellation", () => {
  it("suppresses in-flight agent-progress events after the task is canceled", async () => {
    // Reproduces the regression that left a phantom "Working … Task" chip
    // in the chat footer after pause_agent: the agent loop iterates over
    // every tool call in the latest assistant message, so it kept firing
    // `tool_execution_start` (and therefore `onToolStart`) after
    // `cancelAgent` had already marked the task canceled, leaking
    // `agent-progress` lifecycle events that flipped the task back to
    // running on the desktop.
    const lifecycleEvents: AgentLifecycleEvent[] = [];

    let onToolStartHook: ((toolName: string) => void) | null = null;
    let cancelGate: (() => void) | null = null;
    const cancelGatePromise = new Promise<void>((resolve) => {
      cancelGate = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        onToolStartHook = (toolName) =>
          args.onToolStart?.({ toolName } as never);

        // Simulate an in-flight tool call that fires *before* the orchestrator
        // gets a chance to call cancelAgent.
        onToolStartHook("Read");
        cancelGate?.();

        // Wait until cancelAgent has finished setting status === "canceled",
        // then keep iterating over the remaining tool calls in the same
        // assistant message — these post-cancel onToolStart fires must be
        // ignored by LocalAgentManager.
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            args.abortSignal?.removeEventListener("abort", onAbort);
            try {
              onToolStartHook?.("Write");
              onToolStartHook?.("Edit");
            } catch (error) {
              reject(error as Error);
              return;
            }
            resolve();
          };
          if (args.abortSignal?.aborted) {
            onAbort();
            return;
          }
          args.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });

        return { runId: args.runId, result: "" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "ok" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      onAgentEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const created = await manager.createAgent({
      conversationId: "conv-1",
      description: "demo",
      prompt: "demo prompt",
      agentType: "general",
      storageMode: "local",
    });

    await cancelGatePromise;
    await manager.cancelAgent(created.threadId, AGENT_PAUSE_CANCEL_REASON);
    await waitForTaskCompletion(manager, created.threadId);

    const types = lifecycleEvents.map((entry) => entry.type);
    expect(types).toEqual([
      "agent-started",
      "agent-progress",
      "agent-progress",
      "agent-canceled",
    ]);

    const canceled = lifecycleEvents.find(
      (entry) => entry.type === "agent-canceled",
    );
    expect(canceled?.error).toBe(AGENT_PAUSE_CANCEL_REASON);

    // Anything fired by the agent loop after `cancelAgent` must NOT have
    // produced another `agent-progress` event.
    expect(
      lifecycleEvents.some(
        (entry) =>
          entry.type === "agent-progress" &&
          entry.statusText === "Canceling agent",
      ),
    ).toBe(true);

    const progressCount = lifecycleEvents.filter(
      (entry) => entry.type === "agent-progress",
    ).length;
    expect(progressCount).toBe(2);
  });
});
