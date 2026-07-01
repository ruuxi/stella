import { describe, expect, it } from "vitest";
import {
  extractStepsFromEvents,
  extractTasksFromEvents,
  getTaskDisplayText,
  getTaskGroupStatusText,
  getFooterTasksFromEvents,
  groupActivityTasks,
  mergeFooterTasks,
  type EventRecord,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  buildInlineWorkingIndicatorProps,
  getInlineWorkingIndicatorActive,
  getInlineWorkingIndicatorExitDelayMs,
  getRunningTaskIndicatorText,
  getWorkingIndicatorDisplayStatus,
  shouldTreatResumedAnswerAsPainted,
} from "@/features/chat/working-indicator-state";

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
        statusText: "Running read",
      }),
      event("4", 260, "agent-progress", {
        agentId: "task-1",
        statusText: "Running write",
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
        statusText: "Running read",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("running");
    expect(task.statusText).toBe("Reading");
    expect(task.description).toBe("Open Spotify");
  });

  it("uses send_input description text as the running task display text", () => {
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Open Spotify",
        agentType: "general",
      }),
      event("2", 200, "agent-progress", {
        agentId: "task-1",
        statusText: "Switch to the playlist tab",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("running");
    expect(task.statusText).toBe("Switch to the playlist tab");
    expect(getTaskDisplayText(task)).toBe("Switch to the playlist tab");
  });

  it("humanizes raw tool status text", () => {
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Open Spotify",
        agentType: "general",
        statusText: "Running web",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.statusText).toBe("Searching");
    expect(getTaskDisplayText(task)).toBe("Searching");
  });

  it("does not treat task descriptions as shared working indicator status", () => {
    const footerTasks = getFooterTasksFromEvents([
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Research a current web-backed question",
        agentType: "general",
      }),
    ]);

    expect(footerTasks).toHaveLength(1);
    expect(getRunningTaskIndicatorText(footerTasks[0]!)).toBeUndefined();
  });

  it("humanizes running agent tool progress for task-based status surfaces", () => {
    const footerTasks = getFooterTasksFromEvents([
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Research a current web-backed question",
        agentType: "general",
      }),
      event("2", 150, "agent-progress", {
        agentId: "task-1",
        statusText: "Running web",
      }),
    ]);

    expect(footerTasks).toHaveLength(1);
    expect(getRunningTaskIndicatorText(footerTasks[0]!)).toBe("Searching");
    expect(
      getWorkingIndicatorDisplayStatus({
        tasks: footerTasks,
      }),
    ).toBe("Searching");
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
        statusText: "Running write",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("completed");
    expect(task.outputPreview).toBe("Done");
  });

  it("marks running tasks from a previous app session as stopped", () => {
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Inspect settings",
        agentType: "general",
      }),
      event("2", 150, "agent-progress", {
        agentId: "task-1",
        statusText: "Reading files",
      }),
    ];

    const [task] = extractTasksFromEvents(events, {
      appSessionStartedAtMs: 1_000,
    });

    expect(task.status).toBe("canceled");
    expect(task.outputPreview).toBe("Stopped when Stella restarted.");
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

describe("work-group folding", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("threads groupKey/groupLabel from persisted lifecycle payloads onto tasks", () => {
    const tasks = extractTasksFromEvents([
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Compare flights",
        agentType: "general",
        groupKey: "grp-1",
        groupLabel: "Plan the trip",
      }),
      event("2", 150, "agent-started", {
        agentId: "task-2",
        description: "Compare hotels",
        agentType: "general",
        groupKey: "grp-1",
        groupLabel: "Plan the trip",
      }),
      event("3", 200, "agent-completed", {
        agentId: "task-1",
        result: "Done",
        groupKey: "grp-1",
        groupLabel: "Plan the trip",
      }),
    ]);

    expect(tasks.map((t) => t.groupKey)).toEqual(["grp-1", "grp-1"]);
    expect(tasks[0]?.groupLabel).toBe("Plan the trip");
  });

  it("collapses two members of one group into a single header row", () => {
    const rows = groupActivityTasks([
      task({ id: "task-1", groupKey: "grp-1", groupLabel: "Plan the trip" }),
      task({
        id: "task-2",
        groupKey: "grp-1",
        groupLabel: "Plan the trip",
        startedAtMs: 150,
        lastUpdatedAtMs: 150,
      }),
      task({ id: "task-3", description: "Unrelated" }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["group", "task"]);
    const group = rows[0]!.kind === "group" ? rows[0].group : undefined;
    expect(group?.label).toBe("Plan the trip");
    expect(group?.members.map((member) => member.id)).toEqual([
      "task-1",
      "task-2",
    ]);
  });

  it("leaves legacy rows without group fields untouched", () => {
    const tasks = [
      task({ id: "task-1", description: "Old task" }),
      task({ id: "task-2", description: "Older task", status: "completed" }),
    ];

    const rows = groupActivityTasks(tasks);
    expect(rows).toEqual([
      { kind: "task", task: tasks[0] },
      { kind: "task", task: tasks[1] },
    ]);
  });

  it("renders a singleton group as a plain task row", () => {
    const tasks = [
      task({ id: "task-1", groupKey: "grp-1", groupLabel: "Plan the trip" }),
    ];

    expect(groupActivityTasks(tasks)).toEqual([
      { kind: "task", task: tasks[0] },
    ]);
  });

  it("shows a stable {N} tasks count on the header, not child narration", () => {
    const running = groupActivityTasks([
      task({
        id: "task-1",
        groupKey: "grp-1",
        status: "completed",
        completedAtMs: 200,
        lastUpdatedAtMs: 200,
      }),
      task({
        id: "task-2",
        groupKey: "grp-1",
        statusText: "Comparing 12 flight options",
        lastUpdatedAtMs: 300,
      }),
      task({ id: "task-3", groupKey: "grp-1", lastUpdatedAtMs: 250 }),
    ]);
    expect(running[0]!.kind).toBe("group");
    const runningGroup = running[0]!.kind === "group" ? running[0].group : undefined;
    expect(runningGroup?.status).toBe("running");
    // Never surface an individual member's narration on the group row —
    // that made the header flicker between siblings. Show a stable count.
    expect(getTaskGroupStatusText(runningGroup!)).toBe("3 tasks");

    const done = groupActivityTasks([
      task({
        id: "task-1",
        groupKey: "grp-1",
        status: "completed",
        completedAtMs: 200,
        lastUpdatedAtMs: 200,
      }),
      task({
        id: "task-2",
        groupKey: "grp-1",
        status: "completed",
        completedAtMs: 300,
        lastUpdatedAtMs: 300,
      }),
    ]);
    const doneGroup = done[0]!.kind === "group" ? done[0].group : undefined;
    expect(doneGroup?.status).toBe("completed");
    expect(getTaskGroupStatusText(doneGroup!)).toBe("2 tasks");

    const failed = groupActivityTasks([
      task({
        id: "task-1",
        groupKey: "grp-1",
        status: "completed",
        completedAtMs: 200,
        lastUpdatedAtMs: 200,
      }),
      task({
        id: "task-2",
        groupKey: "grp-1",
        status: "error",
        completedAtMs: 300,
        lastUpdatedAtMs: 300,
      }),
    ]);
    const failedGroup = failed[0]!.kind === "group" ? failed[0].group : undefined;
    expect(failedGroup?.status).toBe("error");
    expect(getTaskGroupStatusText(failedGroup!)).toBe("2 tasks");
  });

  it("keeps the persisted group membership when live tasks lack group fields", () => {
    const persistedTasks = extractTasksFromEvents([
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Compare flights",
        agentType: "general",
        groupKey: "grp-1",
        groupLabel: "Plan the trip",
      }),
    ]);

    // Resume-snapshot live tasks carry no group fields.
    const [merged] = mergeFooterTasks(persistedTasks, [
      task({ id: "task-1", description: "Compare flights", runId: "run-1" }),
    ]);

    expect(merged?.groupKey).toBe("grp-1");
    expect(merged?.groupLabel).toBe("Plan the trip");
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
          statusText: "Running write",
        },
      ],
    );

    expect(merged[0]?.status).toBe("completed");
    expect(merged[0]?.outputPreview).toBe("Done");
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

    const [task] = mergeFooterTasks(persistedTasks, [
      {
        id: "agent-1",
        description: "Task",
        agentType: "general",
        status: "running",
        startedAtMs: 100,
        lastUpdatedAtMs: 200,
      },
    ]);

    expect(task?.description).toBe("Build Tic Tac Toe app in Stella");
    expect(task?.statusText).toBe("Build Tic Tac Toe app in Stella");
    expect(getTaskDisplayText(task!)).toBe("Build Tic Tac Toe app in Stella");
  });
});

describe("getInlineWorkingIndicatorActive", () => {
  it("stays visible through thinking, tools and spawned agents until text is painted", () => {
    // Pre-tool thinking.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: false,
      }),
    ).toBe(true);

    // A tool is actively running.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: true,
      }),
    ).toBe(true);

    // Gap after a fast tool returns, before the next tool/answer: keep the
    // thinking label up instead of going blank.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: false,
      }),
    ).toBe(true);

    // First character actually painted (reveal frontier): hand off.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: true,
        isToolActive: false,
      }),
    ).toBe(false);

    // Run ended: nothing to show.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: false,
        isStreamingResponseText: false,
        isToolActive: false,
      }),
    ).toBe(false);
  });
});

describe("buildInlineWorkingIndicatorProps", () => {
  it("stays visible during pre-text thinking", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: false,
    });
    expect(props.active).toBe(true);
    // Floor-only: never an early dismiss, so no immediate-exit handoff.
    expect(props.exitImmediately).toBeUndefined();
  });

  it("stays visible while a tool / spawned agent is the turn's first action", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: true,
      hasToolActivity: true,
      activeToolName: "spawn_agent",
      activeToolCallId: "call-1",
    });
    expect(props.active).toBe(true);
  });

  it("stays visible after a delta arrives but before the text is painted", () => {
    // `isStreamingResponseText` is now driven by the reveal frontier
    // painting the first character — not by raw delta arrival — so until it
    // flips the indicator must remain up (no dead gap).
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: true,
    });
    expect(props.active).toBe(true);
  });

  it("hands off once the first character is painted", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: true,
      isToolActive: false,
      hasToolActivity: true,
    });
    expect(props.active).toBe(false);
  });
});

describe("shouldTreatResumedAnswerAsPainted", () => {
  it("treats a resumed, already-visible answer with no live overlay as painted", () => {
    expect(
      shouldTreatResumedAnswerAsPainted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(true);
  });

  it("is a no-op while a live overlay is streaming the answer", () => {
    expect(
      shouldTreatResumedAnswerAsPainted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: true,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
  });

  it("does not fire when the resumed run has no visible answer yet (still thinking)", () => {
    expect(
      shouldTreatResumedAnswerAsPainted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: false,
      }),
    ).toBe(false);
  });

  it("is a no-op once the indicator already handed off, or when no run is active", () => {
    expect(
      shouldTreatResumedAnswerAsPainted({
        isStreaming: true,
        isStreamingResponseText: true,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldTreatResumedAnswerAsPainted({
        isStreaming: false,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
  });
});

describe("getInlineWorkingIndicatorExitDelayMs", () => {
  it("holds fast tool calls long enough to be readable", () => {
    expect(
      getInlineWorkingIndicatorExitDelayMs({
        activatedAtMs: 1_000,
        nowMs: 1_250,
      }),
    ).toBe(1_750);

    expect(
      getInlineWorkingIndicatorExitDelayMs({
        activatedAtMs: 1_000,
        nowMs: 3_100,
      }),
    ).toBe(0);
  });
});
