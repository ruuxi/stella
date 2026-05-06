import { describe, expect, it } from "vitest";
import {
  extractStepsFromEvents,
  extractTasksFromEvents,
  getFooterTasksFromEvents,
  mergeFooterTasks,
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
  it("treats agent-canceled as terminal even if a stale agent-progress arrives later", () => {
    // Race recreated by pause_agent: the orchestrator cancels the task while
    // the subagent's agent loop is still iterating tool calls, so a few
    // `agent-progress` lifecycle events get persisted *after* the
    // `agent-canceled` event. Without the terminal guard those late
    // progresses flip the task back to "running" and pin a phantom
    // "Working … Task" indicator in the footer.
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("2", 200, "agent-canceled", {
        agentId: "task-1",
        error: "Paused by orchestrator.",
      }),
      event("3", 250, "agent-progress", {
        agentId: "task-1",
        statusText: "Using Read",
      }),
      event("4", 260, "agent-progress", {
        agentId: "task-1",
        statusText: "Using Write",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("canceled");
    expect(task.outputPreview).toBe("Paused by orchestrator.");

    const footer = getFooterTasksFromEvents(events, { nowMs: 1_000 });
    expect(footer).toEqual([]);
  });

  it("revives a canceled task when send_input emits a fresh agent-started", () => {
    // send_input is the legitimate way to bring a paused task back to
    // running — it resets the status to pending and the manager emits a
    // brand-new `agent-started`. The terminal guard must clear so the
    // revived task actually shows up in the footer again.
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("2", 200, "agent-canceled", {
        agentId: "task-1",
        error: "Paused by orchestrator.",
      }),
      event("3", 300, "agent-started", {
        agentId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("4", 350, "agent-progress", {
        agentId: "task-1",
        statusText: "Using Read",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("running");
    // "Using <toolName>" is general-agent tool-call noise and must be
    // filtered out of `statusText` so the stable user-visible task label
    // stays put instead of leaking internal tool names into the UI.
    expect(task.statusText).toBe("Open Spotify");
    expect(task.description).toBe("Open Spotify");
  });

  it("ignores agent-progress that arrives after agent-completed", () => {
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Summarize PR",
        agentType: "general",
      }),
      event("2", 200, "agent-completed", {
        agentId: "task-1",
        result: "Done",
      }),
      event("3", 250, "agent-progress", {
        agentId: "task-1",
        statusText: "Using Write",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("completed");
    expect(task.outputPreview).toBe("Done");
  });

  it("preserves progress text when a later started event has no status", () => {
    const events = [
      event("1", 100, "agent-progress", {
        agentId: "task-1",
        statusText: "Reading files",
      }),
      event("2", 150, "agent-started", {
        agentId: "task-1",
        description: "Inspect settings",
        agentType: "general",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.description).toBe("Inspect settings");
    expect(task.statusText).toBe("Reading files");
  });
});

describe("extractStepsFromEvents", () => {
  it("does not guess a tool result target when the result has no request id", () => {
    const steps = extractStepsFromEvents([
      event("1", 100, "tool_request", {
        toolName: "exec_command",
        requestId: "tool-1",
      }),
      event("2", 200, "tool_request", {
        toolName: "exec_command",
        requestId: "tool-2",
      }),
      event("3", 300, "tool_result", {
        toolName: "exec_command",
      }),
    ]);

    expect(steps.map((step) => step.status)).toEqual(["running", "running"]);
  });
});

describe("mergeFooterTasks", () => {
  it("does not let stale live state revive a terminal persisted task", () => {
    const merged = mergeFooterTasks(
      [
        {
          id: "task-1",
          description: "Summarize PR",
          agentType: "general",
          status: "completed",
          startedAtMs: 100,
          completedAtMs: 200,
          lastUpdatedAtMs: 200,
          outputPreview: "Done",
        },
      ],
      [
        {
          id: "task-1",
          description: "Summarize PR",
          agentType: "general",
          status: "running",
          startedAtMs: 100,
          lastUpdatedAtMs: 250,
          statusText: "Using Write",
        },
      ],
    );

    expect(merged[0]?.status).toBe("completed");
    expect(merged[0]?.outputPreview).toBe("Done");
  });
});
