import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../src/shared/contracts/agent-runtime.js";
import { createStateContext, handleTask } from "../../../../runtime/kernel/tools/state.js";
import type { TaskToolRequest } from "../../../../runtime/kernel/tools/types.js";

describe("state tools", () => {
  it("always creates general tasks from orchestrator requests", async () => {
    let createdRequest: TaskToolRequest | null = null;
    const ctx = createStateContext("/tmp", {
      createTask: async (request) => {
        createdRequest = request;
        return { threadId: "thread-1" };
      },
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
    });

    const result = await handleTask(
      ctx,
      {
        description: "Do work",
        prompt: "Use the schedule agent",
        subagent_type: "schedule",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(createdRequest?.agentType).toBe(AGENT_IDS.GENERAL);
    expect(result).toEqual({
      result: {
        thread_id: "thread-1",
        status: "running",
        background: true,
        elapsed_ms: 0,
        follow_up_on_completion: true,
      },
    });
  });

  it("rejects task creation from non-orchestrator agents", async () => {
    const ctx = createStateContext("/tmp");

    const result = await handleTask(
      ctx,
      {
        description: "Do work",
        prompt: "Run it",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.GENERAL,
      },
    );

    expect(result).toEqual({
      error: "Only the orchestrator can create tasks.",
    });
  });
});
