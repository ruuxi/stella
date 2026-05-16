import { describe, expect, it } from "vitest";

import {
  LocalAgentManager,
  AGENT_PAUSE_CANCEL_REASON,
  type AgentLifecycleEvent,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { ToolResult } from "../../../../../runtime/kernel/tools/types.js";
import { waitForAgentSettled } from "../../../helpers/agent.js";

const waitFor = async (
  predicate: () => boolean,
  message: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
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
    await waitForAgentSettled(manager, created.threadId);

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
          entry.type === "agent-progress" && entry.statusText === "Pausing",
      ),
    ).toBe(true);

    const progressCount = lifecycleEvents.filter(
      (entry) => entry.type === "agent-progress",
    ).length;
    expect(progressCount).toBe(2);
  });

  it("emits the source lifecycle status text for queued and interrupting input", async () => {
    const lifecycleEvents: AgentLifecycleEvent[] = [];
    let started: (() => void) | null = null;
    let finishRun: (() => void) | null = null;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finishPromise = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        started?.();
        await Promise.race([
          finishPromise,
          new Promise<void>((resolve) => {
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          }),
        ]);
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

    await startedPromise;
    await manager.sendAgentMessage(created.threadId, "later", "orchestrator", {
      interrupt: false,
    });
    await manager.sendAgentMessage(created.threadId, "now", "orchestrator", {
      interrupt: true,
    });

    expect(
      lifecycleEvents.some(
        (event) =>
          event.type === "agent-progress" && event.statusText === "Queued",
      ),
    ).toBe(true);
    expect(
      lifecycleEvents.some(
        (event) =>
          event.type === "agent-progress" && event.statusText === "Updating",
      ),
    ).toBe(true);
    const progressTexts = lifecycleEvents
      .filter((event) => event.type === "agent-progress")
      .map((event) => event.statusText);
    expect(progressTexts).toEqual(["Queued", "demo", "Updating", "demo"]);

    finishRun?.();
    await waitForAgentSettled(manager, created.threadId);
  });

  it("continues with queued send_input after the current run completes", async () => {
    const prompts: string[] = [];
    let startedFirst: (() => void) | null = null;
    let finishFirst: (() => void) | null = null;
    const startedFirstPromise = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const finishFirstPromise = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        prompts.push(args.taskPrompt);
        if (prompts.length === 1) {
          startedFirst?.();
          await finishFirstPromise;
        }
        return { runId: args.runId, result: `done-${prompts.length}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "ok" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const created = await manager.createAgent({
      conversationId: "conv-1",
      description: "demo",
      prompt: "initial prompt",
      agentType: "general",
      storageMode: "local",
    });

    await startedFirstPromise;
    await manager.sendAgentMessage(created.threadId, "queued follow-up", "orchestrator", {
      interrupt: false,
    });
    finishFirst?.();

    await waitFor(
      () => prompts.length === 2,
      "Queued send_input did not start a follow-up run.",
    );
    await waitForAgentSettled(manager, created.threadId);

    expect(prompts[0]).toBe("initial prompt");
    expect(prompts[1]).toContain("Task update from orchestrator:");
    expect(prompts[1]).toContain("queued follow-up");
    expect(prompts[1]).toContain(
      "if it asks a question, requests status, or asks for a report, answer that request and then stop",
    );
    expect(prompts[1]).toContain(
      "If it gives new or changed work instructions, apply them and continue the task",
    );
    await expect(manager.getAgent(created.threadId)).resolves.toMatchObject({
      status: "completed",
      result: "done-2",
    });
  });
});
