import { describe, expect, it } from "vitest";
import { buildAgentEventPrompt } from "../../../../../runtime/kernel/runner/shared.js";
import {
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";

describe("task lifecycle deduping", () => {
  it("does not build hidden orchestrator prompts for agent-started", () => {
    const prompt = buildAgentEventPrompt({
      type: "agent-started",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      description: "Open Spotify",
    });

    expect(prompt).toBeNull();
  });

  it("keeps terminal lifecycle prompts for orchestrator follow-ups", () => {
    const completedPrompt = buildAgentEventPrompt({
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      description: "Open Spotify and play jazz",
      result: "Spotify is now open",
    });
    const failedPrompt = buildAgentEventPrompt({
      type: "agent-failed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: "Spotify failed to open",
    });
    const canceledPrompt = buildAgentEventPrompt({
      type: "agent-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: "Canceled by user",
    });

    expect(completedPrompt).toContain("[Agent completed]");
    expect(completedPrompt).toContain("description: Open Spotify and play jazz");
    expect(completedPrompt).toContain("result: Spotify is now open");
    expect(completedPrompt).toContain(
      "agent_state: paused; this agent is not currently working. Use send_input to resume the same thread if follow-up work is needed.",
    );
    expect(failedPrompt).toContain("[Task failed]");
    expect(failedPrompt).toContain("error: Spotify failed to open");
    expect(canceledPrompt).toContain("[Task canceled]");
    expect(canceledPrompt).toContain("error: Canceled by user");
  });

  it("suppresses the follow-up turn when the orchestrator pauses a task itself", () => {
    // The orchestrator already knows it just paused the task (the pause_agent
    // tool call returned `canceled: true`). Surfacing a hidden
    // `[Task canceled]` follow-up triggers a second assistant turn that
    // typically responds silently and ends up overwriting the user-facing
    // reply, which is the bug this guards against.
    const pausedPrompt = buildAgentEventPrompt({
      type: "agent-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: AGENT_PAUSE_CANCEL_REASON,
    });

    expect(pausedPrompt).toBeNull();
  });

  it("still suppresses the follow-up when Stella shuts down mid-task", () => {
    const shutdownPrompt = buildAgentEventPrompt({
      type: "agent-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: AGENT_SHUTDOWN_CANCEL_REASON,
    });

    expect(shutdownPrompt).toBeNull();
  });
});
