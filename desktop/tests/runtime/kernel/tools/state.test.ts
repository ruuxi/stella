import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { createStateContext, handleSpawnAgent } from "../../../../../runtime/kernel/tools/state.js";
import { AGENT_PAUSE_CANCEL_REASON } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { AgentToolRequest } from "../../../../../runtime/kernel/tools/types.js";

describe("state tools", () => {
  it("always creates general tasks from orchestrator requests", async () => {
    const now = Date.now();
    let createdRequest: AgentToolRequest | null = null;
    const ctx = createStateContext("/tmp", {
      createAgent: async (request) => {
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
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    });

    const result = await handleSpawnAgent(
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
        note:
          "Task has started but is NOT finished yet. Wait for the completion event before telling the user it is done.",
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

    const result = await handleSpawnAgent(
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

  it("replaces generic descriptions with prompt context", async () => {
    let createdRequest: AgentToolRequest | null = null;
    const ctx = createStateContext("/tmp", {
      createAgent: async (request) => {
        createdRequest = request;
        return { threadId: "thread-1" };
      },
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    });

    await handleSpawnAgent(
      ctx,
      {
        description: "Task",
        prompt: "Inspect the working indicator behavior and fix the stale footer text.",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(createdRequest?.description).toBe(
      "Inspect the working indicator behavior and fix the stale footer text.",
    );
  });

  it("forwards pause_agent to cancelAgent with the pause sentinel reason", async () => {
    const cancelCalls: Array<{ agentId: string; reason: string | undefined }> = [];
    const ctx = createStateContext("/tmp", {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async (agentId, reason) => {
        cancelCalls.push({ agentId, reason });
        return { canceled: true };
      },
    });

    const result = await handleSpawnAgent(
      ctx,
      { action: "cancel", thread_id: "thread-7", reason: "user changed their mind" },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(cancelCalls).toEqual([
      { agentId: "thread-7", reason: AGENT_PAUSE_CANCEL_REASON },
    ]);
    expect(result).toEqual({
      result: {
        thread_id: "thread-7",
        status: "canceled",
        canceled: true,
      },
    });
  });

  it("returns thread-not-found when pause_agent targets an unknown thread", async () => {
    const ctx = createStateContext("/tmp", {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    });

    const result = await handleSpawnAgent(
      ctx,
      { action: "cancel", thread_id: "missing-thread" },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(result).toEqual({ error: "Thread not found: missing-thread" });
  });

  it("requires description and prompt for task creation", async () => {
    const ctx = createStateContext("/tmp");

    await expect(
      handleSpawnAgent(
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
      handleSpawnAgent(
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
