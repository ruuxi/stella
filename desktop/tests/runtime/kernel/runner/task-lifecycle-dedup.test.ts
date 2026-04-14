import { describe, expect, it } from "vitest";
import { shouldIncludeInOrchestratorLocalHistory } from "../../../../runtime/kernel/runner/context.js";
import { buildTaskEventPrompt } from "../../../../runtime/kernel/runner/shared.js";

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

  it("keeps lifecycle UI events out of orchestrator local history", () => {
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_started") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_completed") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_failed") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("task_canceled") as never)).toBe(false);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("user_message") as never)).toBe(true);
    expect(shouldIncludeInOrchestratorLocalHistory(makeEvent("tool_result") as never)).toBe(true);
  });
});
