import { describe, expect, it } from "vitest";
import {
  createOrchestratorResponseTargetTracker,
  createTaskLifecycleResponseTarget,
} from "../../../../../runtime/kernel/agent-runtime/response-target.js";

describe("orchestrator response target tracking", () => {
  it("classifies a TaskCreate reply as a task turn", () => {
    const tracker = createOrchestratorResponseTargetTracker();

    tracker.noteToolEnd("TaskCreate", {
      thread_id: "task-1",
    });

    expect(tracker.resolve()).toEqual({
      type: "task_turn",
      taskId: "task-1",
    });
  });

  it("classifies task follow-up tools by thread id", () => {
    const tracker = createOrchestratorResponseTargetTracker();

    tracker.noteToolStart("TaskUpdate", {
      thread_id: "task-1",
    });

    expect(tracker.resolve()).toEqual({
      type: "task_turn",
      taskId: "task-1",
    });
  });

  it("falls back to a normal user turn when multiple task ids are involved", () => {
    const tracker = createOrchestratorResponseTargetTracker();

    tracker.noteToolEnd("TaskCreate", {
      thread_id: "task-1",
    });
    tracker.noteToolEnd("TaskCreate", {
      thread_id: "task-2",
    });

    expect(tracker.resolve()).toEqual({
      type: "user_turn",
    });
  });

  it("tracks task ids surfaced through nested Exec calls", () => {
    const tracker = createOrchestratorResponseTargetTracker();

    tracker.noteToolEnd("Exec", {
      calls: [
        {
          toolName: "task_create",
          args: { description: "run nested task" },
          result: { thread_id: "task-from-exec" },
        },
      ],
    });

    expect(tracker.resolve()).toEqual({
      type: "task_turn",
      taskId: "task-from-exec",
    });
  });
});

describe("task lifecycle response targets", () => {
  it("keeps task completions as separate terminal notices", () => {
    expect(
      createTaskLifecycleResponseTarget({
        taskId: "task-1",
        eventType: "task-completed",
      }),
    ).toEqual({
      type: "task_terminal_notice",
      taskId: "task-1",
      terminalState: "completed",
    });
  });

  it("routes failed and canceled task follow-ups back into the task turn", () => {
    expect(
      createTaskLifecycleResponseTarget({
        taskId: "task-1",
        eventType: "task-failed",
      }),
    ).toEqual({
      type: "task_turn",
      taskId: "task-1",
    });

    expect(
      createTaskLifecycleResponseTarget({
        taskId: "task-1",
        eventType: "task-canceled",
      }),
    ).toEqual({
      type: "task_turn",
      taskId: "task-1",
    });
  });
});
