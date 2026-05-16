import { describe, expect, it } from "vitest";
import { shouldRetainResumedStreamingState } from "../../src/app/chat/hooks/use-resume-agent-run";
import { reconcileTerminalTaskKeysFromResumeTasks } from "../../src/app/chat/streaming/store";

describe("shouldRetainResumedStreamingState", () => {
  it("drops stale resumed state when replay is exhausted and the run is gone", () => {
    expect(
      shouldRetainResumedStreamingState({
        resumedRunId: "run-1",
        resumedConversationId: "conv-1",
        replayEventCount: 0,
        replayExhausted: true,
        currentActiveRun: null,
      }),
    ).toBe(false);
  });

  it("drops stale resumed state when a different run is now active", () => {
    expect(
      shouldRetainResumedStreamingState({
        resumedRunId: "run-1",
        resumedConversationId: "conv-1",
        replayEventCount: 0,
        replayExhausted: true,
        currentActiveRun: {
          runId: "run-2",
          conversationId: "conv-1",
        },
      }),
    ).toBe(false);
  });

  it("keeps resumed state when replay is exhausted but the same run is still active", () => {
    expect(
      shouldRetainResumedStreamingState({
        resumedRunId: "run-1",
        resumedConversationId: "conv-1",
        replayEventCount: 0,
        replayExhausted: true,
        currentActiveRun: {
          runId: "run-1",
          conversationId: "conv-1",
        },
      }),
    ).toBe(true);
  });

  it("keeps resumed state when replay still has buffered context", () => {
    expect(
      shouldRetainResumedStreamingState({
        resumedRunId: "run-1",
        resumedConversationId: "conv-1",
        replayEventCount: 0,
        replayExhausted: false,
        currentActiveRun: null,
      }),
    ).toBe(true);
  });

  it("keeps resumed state when replay includes events", () => {
    expect(
      shouldRetainResumedStreamingState({
        resumedRunId: "run-1",
        resumedConversationId: "conv-1",
        replayEventCount: 2,
        replayExhausted: true,
        currentActiveRun: null,
      }),
    ).toBe(true);
  });
});

describe("reconcileTerminalTaskKeysFromResumeTasks", () => {
  it("adds resumed terminal tasks and clears restarted ones", () => {
    const currentKeys = new Set([
      "run-1:task-1",
      "run-9:task-9",
    ]);

    const nextKeys = reconcileTerminalTaskKeysFromResumeTasks({
      currentKeys,
      tasks: [
        { runId: "run-1", agentId: "task-1", status: "running" },
        { runId: "run-2", agentId: "task-2", status: "completed" },
        { runId: "run-3", agentId: "task-3", status: "error" },
        { runId: "run-4", agentId: "task-4", status: "canceled" },
      ],
    });

    expect([...nextKeys].sort()).toEqual([
      "run-2:task-2",
      "run-3:task-3",
      "run-4:task-4",
      "run-9:task-9",
    ]);
    expect([...currentKeys].sort()).toEqual([
      "run-1:task-1",
      "run-9:task-9",
    ]);
  });
});
