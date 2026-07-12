import { afterEach, describe, expect, it } from "vitest";
import { shouldRetainResumedStreamingState } from "../../src/features/chat/hooks/use-resume-agent-run";
import {
  __privateTaskDecorationStore,
  clearConversationTaskDecorations,
  decorateTask,
  getTaskDecoration,
} from "../../src/features/chat/streaming/task-decoration-store";

afterEach(() => {
  __privateTaskDecorationStore.resetForTests();
});

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
describe("stream resume cleanup", () => {
  it("clears the active conversation's task decorations, keeping other conversations", () => {
    decorateTask({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      statusText: "Inspecting stale footer",
    });
    decorateTask({
      agentId: "agent-2",
      conversationId: "conv-2",
      runId: "run-2",
      statusText: "Keep this decoration",
    });

    clearConversationTaskDecorations("conv-1");

    expect(getTaskDecoration("agent-1")).toBeUndefined();
    expect(getTaskDecoration("agent-2")).toMatchObject({
      conversationId: "conv-2",
      statusText: "Keep this decoration",
    });
  });
});
