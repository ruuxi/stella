import { describe, expect, it } from "vitest";
import {
  extractTasksFromEvents,
  getTaskDisplayText,
  getFooterTasksFromEvents,
  mergeFooterTasks,
  type EventRecord,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { getStickyThinkingFooterState } from "@/app/chat/sticky-thinking-footer-state";
import { getStickyThinkingFooterDisplayText } from "@/app/chat/sticky-thinking-footer-state";

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

const runningTask = (
  id: string,
  startedAtMs: number,
  description: string,
): TaskItem => ({
  id,
  description,
  agentType: "general",
  status: "running",
  startedAtMs,
  lastUpdatedAtMs: startedAtMs,
});

describe("getStickyThinkingFooterState", () => {
  it("shows generic orchestrator status when no agent task is active", () => {
    const state = getStickyThinkingFooterState({
      tasks: [],
      activeIndex: 0,
      isStreaming: true,
      status: "Compacting context",
    });

    expect(state.shouldRender).toBe(true);
    expect(state.activeTask).toBeNull();
    expect(state.status).toBe("Compacting context");
  });

  it("lets active agent task own the footer over orchestrator status", () => {
    const state = getStickyThinkingFooterState({
      tasks: [runningTask("agent-1", 100, "Using Shell")],
      activeIndex: 0,
      isStreaming: true,
      status: "Compacting context",
    });

    expect(state.shouldRender).toBe(true);
    expect(state.activeTask?.id).toBe("agent-1");
    expect(state.activeTask?.description).toBe("Using Shell");
    expect(state.status).toBeUndefined();
  });

  it("rotates among multiple running agents by active index", () => {
    const tasks = [
      runningTask("agent-1", 100, "Using Shell"),
      runningTask("agent-2", 200, "Reading files"),
    ];

    expect(
      getStickyThinkingFooterState({
        tasks,
        activeIndex: 0,
        isStreaming: false,
      }).activeTask?.id,
    ).toBe("agent-1");

    expect(
      getStickyThinkingFooterState({
        tasks,
        activeIndex: 1,
        isStreaming: false,
      }).activeTask?.id,
    ).toBe("agent-2");
  });
});

describe("scripted agent/orchestrator footer scenarios", () => {
  it("keeps a running spawned agent visible while the orchestrator streams a reply", () => {
    const footerTasks = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Inspect settings",
          agentType: "general",
        }),
        event("2", 150, "agent-progress", {
          agentId: "agent-1",
          statusText: "Reading settings files",
        }),
      ],
      { nowMs: 200 },
    );

    const state = getStickyThinkingFooterState({
      tasks: footerTasks,
      activeIndex: 0,
      isStreaming: true,
      status: "Thinking",
    });

    expect(state.activeTask?.id).toBe("agent-1");
    expect(state.activeTask?.statusText).toBe("Reading settings files");
    expect(state.status).toBeUndefined();
  });

  it("shows the spawned agent description while orchestrator text streams", () => {
    const footerTasks = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Inspect settings",
          agentType: "general",
        }),
        event("2", 150, "agent-progress", {
          agentId: "agent-1",
          statusText: "Using read",
        }),
      ],
      { nowMs: 200 },
    );
    const state = getStickyThinkingFooterState({
      tasks: footerTasks,
      activeIndex: 0,
      isStreaming: true,
      status: null,
    });

    expect(getStickyThinkingFooterDisplayText({ state })).toBe(
      "Working · Inspect settings",
    );
  });

  it("uses the spawned agent status text and never displays generic task copy", () => {
    const footerTasks = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Task",
          agentType: "general",
          statusText: "Build Tic Tac Toe app in Stella",
        }),
      ],
      { nowMs: 125 },
    );

    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks: footerTasks,
          activeIndex: 0,
          isStreaming: false,
        }),
      }),
    ).toBe("Working · Build Tic Tac Toe app in Stella");
    expect(getTaskDisplayText(footerTasks[0]!)).toBe(
      "Build Tic Tac Toe app in Stella",
    );
  });

  it("rotates display text across numerous running agents", () => {
    const tasks = [
      runningTask("agent-1", 100, "Reading settings files"),
      runningTask("agent-2", 200, "Using Shell"),
      runningTask("agent-3", 300, "Applying patch"),
    ];

    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks,
          activeIndex: 0,
          isStreaming: false,
        }),
      }),
    ).toBe("Working · Reading settings files");
    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks,
          activeIndex: 1,
          isStreaming: false,
        }),
      }),
    ).toBe("Working · Using Shell");
    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks,
          activeIndex: 2,
          isStreaming: false,
        }),
      }),
    ).toBe("Working · Applying patch");
  });

  it("shows pause progress before the canceled event removes the agent", () => {
    const beforeCanceled = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Inspect settings",
          agentType: "general",
        }),
        event("2", 150, "agent-progress", {
          agentId: "agent-1",
          statusText: "Pausing",
        }),
      ],
      { nowMs: 175 },
    );
    const afterCanceled = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Inspect settings",
          agentType: "general",
        }),
        event("2", 150, "agent-progress", {
          agentId: "agent-1",
          statusText: "Pausing",
        }),
        event("3", 200, "agent-canceled", {
          agentId: "agent-1",
          error: "Paused by orchestrator.",
        }),
      ],
      { nowMs: 250 },
    );

    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks: beforeCanceled,
          activeIndex: 0,
          isStreaming: false,
        }),
      }),
    ).toBe("Pausing · Inspect settings");
    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks: afterCanceled,
          activeIndex: 0,
          isStreaming: false,
        }),
      }),
    ).toBeNull();
  });

  it("shows updating text when send_input interrupts or resumes an agent", () => {
    const footerTasks = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Inspect settings",
          agentType: "general",
          statusText: "Updating",
        }),
      ],
      { nowMs: 150 },
    );

    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks: footerTasks,
          activeIndex: 0,
          isStreaming: false,
        }),
      }),
    ).toBe("Updating · Inspect settings");
  });

  it("keeps operation text clean when context is generic", () => {
    const footerTasks = getFooterTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Task",
          agentType: "general",
          statusText: "Updating",
        }),
      ],
      { nowMs: 150 },
    );

    expect(
      getStickyThinkingFooterDisplayText({
        state: getStickyThinkingFooterState({
          tasks: footerTasks,
          activeIndex: 0,
          isStreaming: false,
        }),
      }),
    ).toBe("Updating");
  });

  it("does not let stale live progress revive a canceled persisted agent", () => {
    const persistedTasks = extractTasksFromEvents(
      [
        event("1", 100, "agent-started", {
          agentId: "agent-1",
          description: "Inspect settings",
          agentType: "general",
        }),
        event("2", 200, "agent-canceled", {
          agentId: "agent-1",
          error: "Paused by orchestrator.",
        }),
      ],
    );
    const liveTasks = [runningTask("agent-1", 100, "Using Shell")];

    const state = getStickyThinkingFooterState({
      tasks: mergeFooterTasks(persistedTasks, liveTasks),
      activeIndex: 0,
      isStreaming: false,
    });

    expect(state.shouldRender).toBe(false);
    expect(state.activeTask).toBeNull();
  });

  it("preserves persisted status text when live state only has a generic placeholder", () => {
    const persistedTasks = extractTasksFromEvents([
      event("1", 100, "agent-started", {
        agentId: "agent-1",
        description: "Build Tic Tac Toe app in Stella",
        agentType: "general",
        statusText: "Build Tic Tac Toe app in Stella",
      }),
    ]);
    const liveTasks: TaskItem[] = [
      {
        id: "agent-1",
        description: "Task",
        agentType: "general",
        status: "running",
        startedAtMs: 100,
        lastUpdatedAtMs: 200,
      },
    ];

    const [task] = mergeFooterTasks(persistedTasks, liveTasks);

    expect(task?.description).toBe("Build Tic Tac Toe app in Stella");
    expect(task?.statusText).toBe("Build Tic Tac Toe app in Stella");
    expect(getTaskDisplayText(task!)).toBe("Build Tic Tac Toe app in Stella");
  });
});
