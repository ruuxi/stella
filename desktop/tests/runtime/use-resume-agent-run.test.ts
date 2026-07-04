import { describe, expect, it } from "vitest";
import { shouldRetainResumedStreamingState } from "../../src/features/chat/hooks/use-resume-agent-run";
import {
  initialStoreState,
  reconcileTerminalTaskKeysFromResumeTasks,
  streamStoreReducer,
  toTaskFromResumeSnapshot,
} from "../../src/features/chat/streaming/store";

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

describe("toTaskFromResumeSnapshot", () => {
  it("marks hydrated tasks so they cannot masquerade as fresh lifecycle events", () => {
    const task = toTaskFromResumeSnapshot(
      {
        runId: "run-1",
        agentId: "task-1",
        status: "running",
        description: "Inspect settings",
      },
      1_000,
    );

    expect(task.hydratedFromResumeSnapshot).toBe(true);
    expect(task.status).toBe("running");
  });

  it("carries the snapshot's real lifecycle timestamps instead of fabricating now", () => {
    const task = toTaskFromResumeSnapshot(
      {
        runId: "run-1",
        agentId: "task-1",
        status: "completed",
        description: "Inspect settings",
        startedAtMs: 200,
        completedAtMs: 450,
      },
      1_000,
    );

    expect(task.startedAtMs).toBe(200);
    expect(task.completedAtMs).toBe(450);
  });

  it("falls back to now only for snapshots that predate real timestamps", () => {
    const task = toTaskFromResumeSnapshot(
      {
        runId: "run-1",
        agentId: "task-1",
        status: "completed",
        description: "Inspect settings",
      },
      1_000,
    );

    expect(task.startedAtMs).toBe(1_000);
    expect(task.completedAtMs).toBe(1_000);
  });

  it("does not surface a completedAtMs on running snapshots", () => {
    const task = toTaskFromResumeSnapshot(
      {
        runId: "run-1",
        agentId: "task-1",
        status: "running",
        description: "Inspect settings",
        startedAtMs: 200,
        completedAtMs: 450,
      },
      1_000,
    );

    expect(task.startedAtMs).toBe(200);
    expect(task.completedAtMs).toBeUndefined();
  });
});

describe("stream resume cleanup", () => {
  it("clears replay-hydrated hidden run tasks for the active conversation", () => {
    const withTask = streamStoreReducer(initialStoreState, {
      type: "task-upsert",
      runId: "run-1",
      conversationId: "conv-1",
      task: {
        id: "agent-1",
        description: "Inspect stale footer",
        agentType: "general",
        status: "running",
        startedAtMs: 100,
        lastUpdatedAtMs: 100,
      },
    });

    expect(Object.keys(withTask.tasksByRunId["run-1"] ?? {})).toEqual([
      "agent-1",
    ]);

    const cleaned = streamStoreReducer(withTask, {
      type: "clear-conversation-tasks",
      conversationId: "conv-1",
    });

    expect(cleaned.tasksByRunId["run-1"]).toBeUndefined();
  });

  it("keeps tasks from other conversations when clearing replay state", () => {
    const withFirstTask = streamStoreReducer(initialStoreState, {
      type: "task-upsert",
      runId: "run-1",
      conversationId: "conv-1",
      task: {
        id: "agent-1",
        description: "Inspect stale footer",
        agentType: "general",
        status: "running",
        startedAtMs: 100,
        lastUpdatedAtMs: 100,
      },
    });
    const withBothTasks = streamStoreReducer(withFirstTask, {
      type: "task-upsert",
      runId: "run-2",
      conversationId: "conv-2",
      task: {
        id: "agent-2",
        description: "Keep this task",
        agentType: "general",
        status: "running",
        startedAtMs: 200,
        lastUpdatedAtMs: 200,
      },
    });

    const cleaned = streamStoreReducer(withBothTasks, {
      type: "clear-conversation-tasks",
      conversationId: "conv-1",
    });

    expect(cleaned.tasksByRunId["run-1"]).toBeUndefined();
    expect(Object.keys(cleaned.tasksByRunId["run-2"] ?? {})).toEqual([
      "agent-2",
    ]);
  });
});
