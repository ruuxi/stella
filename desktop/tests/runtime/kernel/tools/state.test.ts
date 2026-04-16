import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../src/shared/contracts/agent-runtime.js";
import { createStateContext, handleTask } from "../../../../../runtime/kernel/tools/state.js";
import type { TaskToolRequest } from "../../../../../runtime/kernel/tools/types.js";

describe("state tools", () => {
  it("always creates general tasks from orchestrator requests", async () => {
    const now = Date.now();
    let createdRequest: TaskToolRequest | null = null;
    const ctx = createStateContext("/tmp", {
      createTask: async (request) => {
        createdRequest = request;
        return {
          threadId: "thread-1",
          activeThreads: [
            {
              threadId: "thread-1",
              name: "thread-1",
              conversationId: "conversation-1",
              agentType: AGENT_IDS.GENERAL,
              status: "active",
              createdAt: 1,
              lastUsedAt: now,
              description: "Do work",
            },
            {
              threadId: "thread-0",
              name: "thread-0",
              conversationId: "conversation-1",
              agentType: AGENT_IDS.GENERAL,
              status: "active",
              createdAt: 1,
              lastUsedAt: now,
              description: "Previous task",
            },
          ],
        };
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
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        other_threads: [
          {
            thread_id: "thread-0",
            availability: "resumable",
            last_used: "just now",
            description: "Previous task",
          },
        ],
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

  it("requires description and prompt for task creation", async () => {
    const ctx = createStateContext("/tmp");

    await expect(
      handleTask(
        ctx,
        {
          prompt: "Run it",
        },
        {
          conversationId: "conversation-1",
          deviceId: "device-1",
          requestId: "request-1",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toEqual({
      error: "description is required",
    });

    await expect(
      handleTask(
        ctx,
        {
          description: "Do work",
        },
        {
          conversationId: "conversation-1",
          deviceId: "device-1",
          requestId: "request-1",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toEqual({
      error: "prompt is required",
    });
  });
});
