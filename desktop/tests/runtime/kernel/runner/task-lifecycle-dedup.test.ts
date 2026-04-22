import { describe, expect, it } from "vitest";
import { shouldIncludeInOrchestratorLocalHistory } from "../../../../../runtime/kernel/runner/context.js";
import { buildTaskEventPrompt } from "../../../../../runtime/kernel/runner/shared.js";
import {
  TASK_PAUSE_CANCEL_REASON,
  TASK_SHUTDOWN_CANCEL_REASON,
} from "../../../../../runtime/kernel/tasks/local-task-manager.js";

const makeEvent = (type: string) => ({
  _id: `${type}-1`,
  timestamp: 0,
  type,
});

describe("task lifecycle deduping", () => {
  it("does not build hidden orchestrator prompts for task-started", () => {
    const prompt = buildTaskEventPrompt({
      type: "task-started",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      taskId: "task-1",
      agentType: "general",
      description: "Open Spotify",
    });

    expect(prompt).toBeNull();
  });

  it("keeps terminal lifecycle prompts for orchestrator follow-ups", () => {
    const completedPrompt = buildTaskEventPrompt({
      type: "task-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      taskId: "task-1",
      agentType: "general",
      result: "Spotify is now open",
    });
    const failedPrompt = buildTaskEventPrompt({
      type: "task-failed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      taskId: "task-1",
      agentType: "general",
      error: "Spotify failed to open",
    });
    const canceledPrompt = buildTaskEventPrompt({
      type: "task-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      taskId: "task-1",
      agentType: "general",
      error: "Canceled by user",
    });

    expect(completedPrompt).toContain("[Task completed]");
    expect(completedPrompt).toContain("result: Spotify is now open");
    expect(failedPrompt).toContain("[Task failed]");
    expect(failedPrompt).toContain("error: Spotify failed to open");
    expect(canceledPrompt).toContain("[Task canceled]");
    expect(canceledPrompt).toContain("error: Canceled by user");
  });

  it("suppresses the follow-up turn when the orchestrator pauses a task itself", () => {
    // The orchestrator already knows it just paused the task (the TaskPause
    // tool call returned `canceled: true`). Surfacing a hidden
    // `[Task canceled]` follow-up triggers a second assistant turn that
    // typically responds silently and ends up overwriting the user-facing
    // reply, which is the bug this guards against.
    const pausedPrompt = buildTaskEventPrompt({
      type: "task-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      taskId: "task-1",
      agentType: "general",
      error: TASK_PAUSE_CANCEL_REASON,
    });

    expect(pausedPrompt).toBeNull();
  });

  it("still suppresses the follow-up when Stella shuts down mid-task", () => {
    const shutdownPrompt = buildTaskEventPrompt({
      type: "task-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      taskId: "task-1",
      agentType: "general",
      error: TASK_SHUTDOWN_CANCEL_REASON,
    });

    expect(shutdownPrompt).toBeNull();
  });

  it("keeps lifecycle UI events out of orchestrator local history", () => {
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_started") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_completed") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_failed") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_canceled") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("user_message") as never)).toBe(true);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("tool_result") as never)).toBe(true);
  });
});
