import { describe, expect, it } from "vitest";
import {
  extractTasksFromEvents,
  getFooterTasksFromEvents,
  type EventRecord,
} from "@/app/chat/lib/event-transforms";

const event = (
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown>,
): EventRecord => ({
  _id: id,
  timestamp,
  type,
  payload,
});

describe("extractTasksFromEvents", () => {
  it("treats task_canceled as terminal even if a stale task_progress arrives later", () => {
    // Race recreated by TaskPause: the orchestrator cancels the task while
    // the subagent's agent loop is still iterating tool calls, so a few
    // `task_progress` lifecycle events get persisted *after* the
    // `task_canceled` event. Without the terminal guard those late
    // progresses flip the task back to "running" and pin a phantom
    // "Working … Task" indicator in the footer.
    const events = [
      event("1", 100, "task_started", {
        taskId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("2", 200, "task_canceled", {
        taskId: "task-1",
        error: "Paused by orchestrator.",
      }),
      event("3", 250, "task_progress", {
        taskId: "task-1",
        statusText: "Using Read",
      }),
      event("4", 260, "task_progress", {
        taskId: "task-1",
        statusText: "Using Write",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("canceled");
    expect(task.outputPreview).toBe("Paused by orchestrator.");

    const footer = getFooterTasksFromEvents(events, { nowMs: 1_000 });
    expect(footer).toEqual([]);
  });

  it("revives a canceled task when TaskUpdate emits a fresh task_started", () => {
    // TaskUpdate is the legitimate way to bring a paused task back to
    // running — it resets the status to pending and the manager emits a
    // brand-new `task_started`. The terminal guard must clear so the
    // revived task actually shows up in the footer again.
    const events = [
      event("1", 100, "task_started", {
        taskId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("2", 200, "task_canceled", {
        taskId: "task-1",
        error: "Paused by orchestrator.",
      }),
      event("3", 300, "task_started", {
        taskId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("4", 350, "task_progress", {
        taskId: "task-1",
        statusText: "Using Read",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("running");
    expect(task.statusText).toBe("Using Read");
  });

  it("ignores task_progress that arrives after task_completed", () => {
    const events = [
      event("1", 100, "task_started", {
        taskId: "task-1",
        description: "Summarize PR",
        agentType: "general",
      }),
      event("2", 200, "task_completed", {
        taskId: "task-1",
        result: "Done",
      }),
      event("3", 250, "task_progress", {
        taskId: "task-1",
        statusText: "Using Write",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("completed");
    expect(task.outputPreview).toBe("Done");
  });
});
