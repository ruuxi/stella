import { describe, expect, it } from "vitest";
import {
  fallbackTaskDescription,
  isActivityFeedTask,
  isFallbackTaskDescription,
  extractStepsFromEvents,
  extractTasksFromEvents,
  getTaskDisplayText,
  getTaskGroupStatusText,
  getFooterTasksFromEvents,
  groupActivityTasks,
  mergeFooterTasks,
  pruneGroupExpandOverrides,
  shouldShowTaskReasoningSummaries,
  updateSeenRunningGroupKeys,
  updateSeenRunningTaskIds,
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

describe("internal helper agent exclusion", () => {
  it("keeps only general agents in the activity feed", () => {
    expect(isActivityFeedTask({ agentType: "general" })).toBe(true);
    expect(isActivityFeedTask({ agentType: "schedule" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "dream" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "orchestrator" })).toBe(false);
  });

  it("drops schedule-specialist lifecycle events from extracted activity tasks", () => {
    // The Schedule tool spawns an internal `schedule` sub-agent
    // (thread-NNN) while the orchestrator is busy — it must never render
    // as a user-facing activity row.
    const events = [
      event("1", 100, "agent-started", {
        agentId: "thread-177",
        description: "Apply local scheduling changes",
        agentType: "schedule",
      }),
      event("2", 150, "agent-started", {
        agentId: "compare-flight-prices",
        description: "Compare flight prices",
        agentType: "general",
      }),
      event("3", 200, "agent-completed", {
        agentId: "thread-177",
        result: "done",
      }),
    ];
    const tasks = extractTasksFromEvents(events);
    expect(tasks.map((task) => task.id)).toEqual(["compare-flight-prices"]);
  });
});

describe("fallbackTaskDescription", () => {
  it("de-slugs descriptive thread ids into a readable label", () => {
    expect(
      fallbackTaskDescription("morph-animation-test-rig-in-harness-hmr-reload"),
    ).toBe("Morph animation test rig in harness hmr reload");
  });

  it("keeps 'Task' for ordinal/namespace/opaque ids with no real words", () => {
    expect(fallbackTaskDescription("task-7")).toBe("Task");
    expect(fallbackTaskDescription("grp-abc123")).toBe("Task");
    expect(fallbackTaskDescription(undefined)).toBe("Task");
    expect(fallbackTaskDescription("1234-5678")).toBe("Task");
    expect(fallbackTaskDescription("a1")).toBe("Task");
  });

  it("only de-slugs ids in the spawn-slug format", () => {
    // Underscores, uppercase, and other alphabets never come out of the
    // runtime's slugify(); such ids are opaque, not withheld descriptions.
    expect(fallbackTaskDescription("fix_the_bug")).toBe("Task");
    expect(fallbackTaskDescription("Fix-The-Bug")).toBe("Task");
    expect(fallbackTaskDescription("fix the bug")).toBe("Task");
    expect(fallbackTaskDescription("-fix-the-bug")).toBe("Task");
    // Longer than slugify's 48-char cap.
    expect(
      fallbackTaskDescription(
        "compare-flight-prices-for-the-family-trip-to-portugal-in-june",
      ),
    ).toBe("Task");
    expect(fallbackTaskDescription("x7f")).toBe("Task");
  });

  it("still de-slugs meaningful single-word ids", () => {
    expect(fallbackTaskDescription("research")).toBe("Research");
  });

  it("marks generic and id-derived labels as fallback, real ones not", () => {
    expect(isFallbackTaskDescription("Task", "fix-the-bug")).toBe(true);
    expect(isFallbackTaskDescription("Fix the bug", "fix-the-bug")).toBe(true);
    expect(
      isFallbackTaskDescription("Fix the sidebar labeling bug", "fix-the-bug"),
    ).toBe(false);
  });
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

  it("revives a completed task when send_input emits a fresh agent-started", () => {
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Inspect settings",
        agentType: "general",
      }),
      event("2", 200, "agent-completed", {
        agentId: "task-1",
        result: "Done",
      }),
      event("3", 300, "agent-started", {
        agentId: "task-1",
        description: "Inspect settings",
        agentType: "general",
        statusText: "Check one more path",
        isFollowUp: true,
      }),
      event("4", 350, "agent-progress", {
        agentId: "task-1",
        statusText: "Running read",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("running");
    expect(task.completedAtMs).toBeUndefined();
    expect(task.statusText).toBe("Reading");
    expect(shouldShowTaskReasoningSummaries(task)).toBe(true);
  });

  it("marks a resumed completed task finished at the follow-up completion", () => {
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Inspect settings",
        agentType: "general",
      }),
      event("2", 200, "agent-completed", {
        agentId: "task-1",
        result: "First pass done",
      }),
      event("3", 300, "agent-started", {
        agentId: "task-1",
        description: "Inspect settings",
        agentType: "general",
        statusText: "Check one more path",
        isFollowUp: true,
      }),
      event("4", 400, "agent-completed", {
        agentId: "task-1",
        result: "Follow-up done",
      }),
    ];

    const [task] = extractTasksFromEvents(events);
    expect(task.status).toBe("completed");
    expect(task.completedAtMs).toBe(400);
    expect(task.outputPreview).toBe("Follow-up done");
    expect(shouldShowTaskReasoningSummaries(task)).toBe(false);
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

  it("lets a newer live send_input run revive a completed persisted task", () => {
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
          runId: "run-2",
          startedAtMs: 300,
          lastUpdatedAtMs: 350,
          statusText: "Running read",
        },
      ],
    );

    expect(merged[0]?.status).toBe("running");
    expect(merged[0]?.completedAtMs).toBeUndefined();
    expect(merged[0]?.outputPreview).toBeUndefined();
    expect(getTaskDisplayText(merged[0]!)).toBe("Reading");
    expect(shouldShowTaskReasoningSummaries(merged[0]!)).toBe(true);
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

  it("keeps a richer persisted description over a live id-derived fallback", () => {
    const [task] = mergeFooterTasks(
      [
        {
          id: "fix-the-bug",
          description: "Fix the flaky teardown race in the fixture suite",
          agentType: "general",
          status: "running",
          startedAtMs: 100,
          lastUpdatedAtMs: 200,
        },
      ],
      [
        {
          id: "fix-the-bug",
          // Merely the de-slugged id — not a real spawn description; it
          // must not clobber the persisted one.
          description: "Fix the bug",
          agentType: "general",
          status: "running",
          startedAtMs: 100,
          lastUpdatedAtMs: 250,
        },
      ],
    );

    expect(task?.description).toBe(
      "Fix the flaky teardown race in the fixture suite",
    );
  });
});

describe("pruneGroupExpandOverrides", () => {
  const member = (id: string, groupKey?: string): TaskItem => ({
    id,
    description: id,
    agentType: "general",
    status: "running",
    startedAtMs: 1,
    lastUpdatedAtMs: 1,
    ...(groupKey ? { groupKey, groupLabel: "Research" } : {}),
  });

  it("keeps an override while the group is shrunk to a single member, so it still applies after a regrow", () => {
    const overrides: ReadonlyMap<string, boolean> = new Map([
      ["grp-research", false],
    ]);

    // Shrunk to one member: renders as a plain task row, but the group is
    // still alive — the user's explicit collapse must not be pruned.
    const shrunk = pruneGroupExpandOverrides(overrides, [
      member("a", "grp-research"),
    ]);
    expect(shrunk.get("grp-research")).toBe(false);

    // Regrown to a group row: the collapse choice still applies.
    const regrown = pruneGroupExpandOverrides(shrunk, [
      member("a", "grp-research"),
      member("b", "grp-research"),
    ]);
    expect(regrown.get("grp-research")).toBe(false);
  });

  it("drops an override once no member of the group remains", () => {
    const overrides: ReadonlyMap<string, boolean> = new Map([
      ["grp-research", true],
    ]);
    const pruned = pruneGroupExpandOverrides(overrides, [member("solo")]);
    expect(pruned.has("grp-research")).toBe(false);
    expect(pruned.size).toBe(0);
  });

  it("returns the same map reference when nothing is stale", () => {
    const overrides: ReadonlyMap<string, boolean> = new Map([
      ["grp-research", true],
    ]);
    expect(
      pruneGroupExpandOverrides(overrides, [member("a", "grp-research")]),
    ).toBe(overrides);
    const empty: ReadonlyMap<string, boolean> = new Map();
    expect(pruneGroupExpandOverrides(empty, [member("solo")])).toBe(empty);
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

describe("shouldShowTaskReasoningSummaries", () => {
  it("shows summaries only while the agent is actively running", () => {
    expect(shouldShowTaskReasoningSummaries({ status: "running" })).toBe(true);
    // Once the agent stops, the summaries section collapses away — the row
    // stays expanded with its files, but live-narration phrases hide.
    expect(shouldShowTaskReasoningSummaries({ status: "completed" })).toBe(
      false,
    );
    expect(shouldShowTaskReasoningSummaries({ status: "error" })).toBe(false);
    expect(shouldShowTaskReasoningSummaries({ status: "canceled" })).toBe(
      false,
    );
  });
});

describe("seen-running expansion stickiness", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("keeps a task's id after it completes (row must not auto-collapse)", () => {
    const whileRunning = updateSeenRunningTaskIds(new Set(), [
      task({ id: "a1" }),
    ]);
    expect(whileRunning.has("a1")).toBe(true);
    const afterCompletion = updateSeenRunningTaskIds(whileRunning, [
      task({ id: "a1", status: "completed" }),
    ]);
    expect(afterCompletion.has("a1")).toBe(true);
  });

  it("never admits tasks that were only ever seen completed (history rows)", () => {
    const seen = updateSeenRunningTaskIds(new Set(), [
      task({ id: "old", status: "completed" }),
    ]);
    expect(seen.has("old")).toBe(false);
  });

  it("prunes ids whose task left the list and keeps the reference stable otherwise", () => {
    const seen = updateSeenRunningTaskIds(new Set(), [task({ id: "a1" })]);
    // Unchanged input → same reference (memo-friendly).
    expect(updateSeenRunningTaskIds(seen, [task({ id: "a1" })])).toBe(seen);
    // Task aged out of the window → id pruned.
    const pruned = updateSeenRunningTaskIds(seen, [
      task({ id: "other", status: "completed" }),
    ]);
    expect(pruned.has("a1")).toBe(false);
  });

  it("survives a send_input re-run cycle (running → completed → running → completed)", () => {
    let seen: ReadonlySet<string> = new Set();
    seen = updateSeenRunningTaskIds(seen, [task({ id: "a1" })]);
    seen = updateSeenRunningTaskIds(seen, [
      task({ id: "a1", status: "completed" }),
    ]);
    seen = updateSeenRunningTaskIds(seen, [task({ id: "a1" })]);
    seen = updateSeenRunningTaskIds(seen, [
      task({ id: "a1", status: "completed" }),
    ]);
    expect(seen.has("a1")).toBe(true);
  });

  it("tracks group keys while any member runs and keeps them after all finish", () => {
    const whileRunning = updateSeenRunningGroupKeys(new Set(), [
      task({ id: "a1", groupKey: "g1" }),
      task({ id: "a2", groupKey: "g1", status: "completed" }),
    ]);
    expect(whileRunning.has("g1")).toBe(true);
    const done = updateSeenRunningGroupKeys(whileRunning, [
      task({ id: "a1", groupKey: "g1", status: "completed" }),
      task({ id: "a2", groupKey: "g1", status: "completed" }),
    ]);
    expect(done.has("g1")).toBe(true);
    // Group keeps its key even when it shrinks to a single member (renders
    // as a plain task row), mirroring pruneGroupExpandOverrides.
    const shrunk = updateSeenRunningGroupKeys(done, [
      task({ id: "a1", groupKey: "g1", status: "completed" }),
    ]);
    expect(shrunk.has("g1")).toBe(true);
    // ...and prunes once no member remains.
    const gone = updateSeenRunningGroupKeys(shrunk, [
      task({ id: "b1", status: "completed" }),
    ]);
    expect(gone.has("g1")).toBe(false);
  });
});
