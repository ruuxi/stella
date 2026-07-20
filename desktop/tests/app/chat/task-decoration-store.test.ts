import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __privateTaskDecorationStore,
  appendTaskReasoning,
  clearTaskDecoration,
  decorateTask,
  getTaskDecoration,
  getTaskDecorationsSnapshot,
  MAX_TASK_DECORATIONS,
  settleTaskDecoration,
  subscribeTaskDecoration,
  subscribeTaskDecorations,
} from "@/features/chat/streaming/task-decoration-store";

afterEach(() => {
  __privateTaskDecorationStore.resetForTests();
});

describe("task-decoration-store", () => {
  it("merges decorate + reasoning per thread and keeps a stable snapshot between writes", () => {
    decorateTask({
      agentId: "t1",
      conversationId: "c1",
      runId: "r1",
      statusText: "Reading guides",
    });
    appendTaskReasoning({ agentId: "t1", conversationId: "c1", chunk: "ab" });
    appendTaskReasoning({ agentId: "t1", conversationId: "c1", chunk: "cd" });
    expect(getTaskDecoration("t1")).toMatchObject({
      runId: "r1",
      statusText: "Reading guides",
      reasoningText: "abcd",
    });
    const first = getTaskDecorationsSnapshot();
    expect(getTaskDecorationsSnapshot()).toBe(first);
    decorateTask({ agentId: "t1", conversationId: "c1", statusText: "Next" });
    expect(getTaskDecorationsSnapshot()).not.toBe(first);
  });

  it("notifies per-agent subscribers only for their own thread", () => {
    const mine = vi.fn();
    const global = vi.fn();
    subscribeTaskDecoration("t1", mine);
    subscribeTaskDecorations(global);
    decorateTask({ agentId: "t2", conversationId: "c1", statusText: "x" });
    expect(mine).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledTimes(1);
    decorateTask({ agentId: "t1", conversationId: "c1", statusText: "y" });
    expect(mine).toHaveBeenCalledTimes(1);
    clearTaskDecoration("t1");
    expect(mine).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer resumed attempt active when an older completion arrives late", () => {
    decorateTask({
      agentId: "t1",
      conversationId: "c1",
      runId: "follow-up-root",
      attemptGeneration: 8,
      lifecycleSequence: 80,
      startsAttempt: true,
      statusText: "Stop milestone spam",
    });

    settleTaskDecoration({
      agentId: "t1",
      conversationId: "c1",
      runId: "old-root",
      attemptGeneration: 7,
      lifecycleSequence: 90,
      status: "completed",
    });

    expect(getTaskDecoration("t1")).toMatchObject({
      status: "running",
      attemptGeneration: 8,
      runId: "follow-up-root",
      statusText: "Stop milestone spam",
    });
  });

  it("settles only the latest attempt and lets its later completion win", () => {
    decorateTask({
      agentId: "t1",
      conversationId: "c1",
      runId: "follow-up-root",
      attemptGeneration: 8,
      lifecycleSequence: 80,
      startsAttempt: true,
    });
    settleTaskDecoration({
      agentId: "t1",
      conversationId: "c1",
      runId: "follow-up-root",
      attemptGeneration: 8,
      lifecycleSequence: 100,
      status: "completed",
    });
    expect(getTaskDecoration("t1")).toMatchObject({
      status: "completed",
      attemptGeneration: 8,
      lifecycleSequence: 100,
    });
  });

  it("caps the map by evicting the least-recently-updated entry, only on genuinely new keys", () => {
    for (let index = 0; index < MAX_TASK_DECORATIONS; index += 1) {
      decorateTask({
        agentId: `t${index}`,
        conversationId: "c1",
        statusText: `s${index}`,
      });
    }
    // Updating an existing key at the cap must not evict anything.
    decorateTask({ agentId: "t5", conversationId: "c1", statusText: "fresh" });
    expect(Object.keys(getTaskDecorationsSnapshot())).toHaveLength(
      MAX_TASK_DECORATIONS,
    );
    expect(getTaskDecoration("t0")).toBeDefined();
    // A new key past the cap evicts the oldest entry.
    decorateTask({ agentId: "overflow", conversationId: "c1", statusText: "z" });
    expect(Object.keys(getTaskDecorationsSnapshot())).toHaveLength(
      MAX_TASK_DECORATIONS,
    );
    expect(getTaskDecoration("overflow")).toBeDefined();
  });
});
