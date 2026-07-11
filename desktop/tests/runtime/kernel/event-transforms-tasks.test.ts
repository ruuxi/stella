import { describe, expect, it } from "vitest";
import {
  EMPTY_FIRST_SEEN_ORDER,
  activityRowKey,
  fallbackTaskDescription,
  isActivityFeedTask,
  isFallbackTaskDescription,
  extractStepsFromEvents,
  extractTasksFromActivities,
  extractTasksFromEvents,
  getTaskDisplayText,
  getTaskGroupStatusText,
  getFooterTasksFromEvents,
  groupActivityTasks,
  mergeFooterTasks,
  orderByFirstSeen,
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
  shouldTreatResumedAnswerAsStarted,
} from "@/features/chat/working-indicator-state";
import { buildAgentProgressSignature } from "@/features/chat/use-agent-progress-summary-engine";

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
  it("keeps redacted task tool activity and gives distinct commands distinct summary signatures", () => {
    const firstActivity = {
      toolCallId: "call-1",
      toolName: "exec_command",
      label: "Running command",
      argsHint: '{"cmd":"git status"}',
      state: "started" as const,
    };
    const secondActivity = {
      ...firstActivity,
      toolCallId: "call-2",
      argsHint: '{"cmd":"git diff"}',
    };
    const events = [
      event("1", 100, "agent-started", {
        agentId: "task-1",
        description: "Inspect repository",
        agentType: "general",
      }),
      event("2", 200, "agent-progress", {
        agentId: "task-1",
        statusText: "Running command",
        toolActivity: firstActivity,
      }),
    ];

    const [firstTask] = extractTasksFromEvents(events);
    const secondTask: TaskItem = {
      ...firstTask,
      toolActivity: secondActivity,
    };

    expect(firstTask.toolActivity).toEqual(firstActivity);
    expect(buildAgentProgressSignature(firstTask)).not.toBe(
      buildAgentProgressSignature(secondTask),
    );
  });

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

  it("does not infer task cancellation from the desktop app session", () => {
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

    // Regression: the Electron app can restart/reconnect while its detached
    // runtime worker and task keep running. The removed selector option used
    // to turn both rows into `canceled` solely because their last event was
    // older than the desktop process. Cast the old call shape deliberately so
    // this test fails against the pre-fix implementation.
    const legacySelector = extractTasksFromEvents as (
      records: EventRecord[],
      options: { appSessionStartedAtMs: number },
    ) => TaskItem[];
    const [task] = legacySelector(events, { appSessionStartedAtMs: 1_000 });

    expect(task.status).toBe("running");
    expect(task.outputPreview).toBeUndefined();
  });

  it("keeps two authoritative rows running across foreground busy toggles, reorder, and reconnect", () => {
    const rawActivity = [
      event("alpha-start", 100, "agent-started", {
        agentId: "alpha",
        agentType: "general",
        description: "Alpha task",
        rootRunId: "run-background-alpha",
      }),
      event("beta-start", 200, "agent-started", {
        agentId: "beta",
        agentType: "general",
        description: "Beta task",
        rootRunId: "run-background-beta",
      }),
    ];
    const legacySelector = extractTasksFromActivities as (
      records: EventRecord[],
      options: { appSessionStartedAtMs: number },
    ) => TaskItem[];
    const persisted = legacySelector(rawActivity, {
      appSessionStartedAtMs: 1_000,
    });
    const statuses = (tasks: TaskItem[]) =>
      Object.fromEntries(tasks.map((item) => [item.id, item.status]));

    // Idle: fresh live observations exist for both background task runs.
    const idle = mergeFooterTasks(
      persisted,
      persisted.map((item) => ({
        ...item,
        hydratedFromResumeSnapshot: false,
      })),
    );
    // Foreground busy/reconnect: the same tasks are replay-hydrated while a
    // different orchestrator run is active. Their own lifecycle did not move.
    const busy = mergeFooterTasks(
      persisted,
      persisted.map((item) => ({
        ...item,
        hydratedFromResumeSnapshot: true,
      })),
    );
    const idleAgain = mergeFooterTasks(persisted, []);

    expect(statuses(idle)).toEqual({ alpha: "running", beta: "running" });
    expect(statuses(busy)).toEqual({ alpha: "running", beta: "running" });
    expect(statuses(idleAgain)).toEqual({
      alpha: "running",
      beta: "running",
    });
    expect(persisted.map((item) => item.runId)).toEqual([
      "run-background-alpha",
      "run-background-beta",
    ]);

    const firstRows = groupActivityTasks(busy);
    const firstOrder = orderByFirstSeen(
      firstRows,
      activityRowKey,
      EMPTY_FIRST_SEEN_ORDER,
      true,
    );
    expect(firstOrder.ordered.map(activityRowKey)).toEqual([
      "task:beta",
      "task:alpha",
    ]);

    const reorderedActivity = [
      ...rawActivity,
      event("gamma-start", 300, "agent-started", {
        agentId: "gamma",
        agentType: "general",
        description: "Gamma task",
        rootRunId: "run-foreground",
      }),
    ];
    const reorderedRows = groupActivityTasks(
      extractTasksFromActivities(reorderedActivity),
    );
    const afterPrepend = orderByFirstSeen(
      reorderedRows,
      activityRowKey,
      firstOrder.state,
      true,
    );
    expect(afterPrepend.ordered.map(activityRowKey)).toEqual([
      "task:gamma",
      "task:beta",
      "task:alpha",
    ]);
    expect(statuses(busy)).toEqual({ alpha: "running", beta: "running" });

    // A reconnect gives the renderer new event/object identities, but row
    // keys, task run ownership, and statuses remain identical.
    const reconnected = extractTasksFromActivities(
      structuredClone(rawActivity),
    );
    expect(
      reconnected.map((item) => ({
        id: item.id,
        runId: item.runId,
        status: item.status,
      })),
    ).toEqual([
      {
        id: "alpha",
        runId: "run-background-alpha",
        status: "running",
      },
      {
        id: "beta",
        runId: "run-background-beta",
        status: "running",
      },
    ]);
  });

  it("reconciles restart outcomes monotonically without blanket-pausing rows", () => {
    const restartedActivity = [
      event("running-start", 100, "agent-started", {
        agentId: "still-running",
        agentType: "general",
        description: "Still running",
        rootRunId: "run-running",
        groupKey: "grp-restart",
        groupLabel: "Restart checks",
      }),
      event("completed-start", 110, "agent-started", {
        agentId: "completed-while-away",
        agentType: "general",
        description: "Completed while away",
        rootRunId: "run-completed",
        groupKey: "grp-restart",
        groupLabel: "Restart checks",
      }),
      event("completed-end", 210, "agent-completed", {
        agentId: "completed-while-away",
        rootRunId: "run-completed",
        result: "Finished while the desktop was down",
        groupKey: "grp-restart",
        groupLabel: "Restart checks",
      }),
      event("paused-start", 120, "agent-started", {
        agentId: "paused-while-away",
        agentType: "general",
        description: "Paused while away",
        rootRunId: "run-paused",
      }),
      event("paused-end", 220, "agent-canceled", {
        agentId: "paused-while-away",
        rootRunId: "run-paused",
        error: "Paused by orchestrator.",
      }),
      event("failed-start", 130, "agent-started", {
        agentId: "failed-while-away",
        agentType: "general",
        description: "Failed while away",
        rootRunId: "run-failed",
      }),
      event("failed-end", 230, "agent-failed", {
        agentId: "failed-while-away",
        rootRunId: "run-failed",
        error: "Provider failed",
      }),
    ].sort((a, b) => a.timestamp - b.timestamp);

    // This is the delayed/unavailable-runtime case: only durable activity is
    // available provisionally. It must preserve the one genuinely-running
    // row rather than blanket-reset every pre-restart task to paused.
    const tasks = extractTasksFromActivities(restartedActivity);
    expect(
      Object.fromEntries(tasks.map((item) => [item.id, item.status])),
    ).toEqual({
      "still-running": "running",
      "completed-while-away": "completed",
      "paused-while-away": "canceled",
      "failed-while-away": "error",
    });
    expect(groupActivityTasks(tasks)[0]).toMatchObject({
      kind: "group",
      group: {
        groupKey: "grp-restart",
        status: "running",
        totalCount: 2,
      },
    });

    // A true runtime-worker restart emits an authoritative canceled event for
    // orphaned work. Appending that event settles only the affected row.
    const afterWorkerRestart = extractTasksFromActivities([
      ...restartedActivity,
      event("running-orphaned", 300, "agent-canceled", {
        agentId: "still-running",
        error: "Canceled because Stella restarted before the agent finished.",
        groupKey: "grp-restart",
        groupLabel: "Restart checks",
      }),
    ]);
    expect(
      afterWorkerRestart.find((item) => item.id === "still-running")?.status,
    ).toBe("canceled");
    expect(
      afterWorkerRestart.find((item) => item.id === "completed-while-away")
        ?.status,
    ).toBe("completed");
  });

  it("ignores duplicate old-run terminal replay after a newer run starts", () => {
    const tasks = extractTasksFromActivities([
      event("old-start", 100, "agent-started", {
        agentId: "thread-1",
        agentType: "general",
        description: "Thread 1",
        rootRunId: "run-old",
      }),
      event("old-complete", 200, "agent-completed", {
        agentId: "thread-1",
        rootRunId: "run-old",
        result: "Old result",
      }),
      event("new-start", 300, "agent-started", {
        agentId: "thread-1",
        agentType: "general",
        description: "Thread 1",
        rootRunId: "run-new",
        isFollowUp: true,
      }),
      // Duplicate/out-of-order replay from the prior execution. Root-run
      // identity prevents it from terminalizing the newer live execution.
      event("old-complete-replay", 400, "agent-completed", {
        agentId: "thread-1",
        rootRunId: "run-old",
        result: "Old result",
      }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "thread-1",
      runId: "run-new",
      status: "running",
    });
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
    const runningGroup =
      running[0]!.kind === "group" ? running[0].group : undefined;
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
    const failedGroup =
      failed[0]!.kind === "group" ? failed[0].group : undefined;
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

  it("keeps a run-scoped live task visible even when its preserved start predates the terminal row", () => {
    const merged = mergeFooterTasks(
      [
        {
          id: "task-1",
          description: "Summarize PR",
          agentType: "general",
          status: "completed",
          startedAtMs: 100,
          completedAtMs: 500,
          lastUpdatedAtMs: 500,
          outputPreview: "Done",
        },
      ],
      [
        {
          id: "task-1",
          description: "Summarize PR",
          agentType: "general",
          status: "running",
          runId: "run-follow-up",
          startedAtMs: 100,
          lastUpdatedAtMs: 600,
          statusText: "Running read",
        },
      ],
    );

    expect(merged[0]?.status).toBe("running");
    expect(merged[0]?.completedAtMs).toBeUndefined();
    expect(merged[0]?.outputPreview).toBeUndefined();
    expect(getTaskDisplayText(merged[0]!)).toBe("Reading");
  });

  it("clears a persisted error state when the same thread is live again", () => {
    const merged = mergeFooterTasks(
      [
        {
          id: "task-1",
          description: "Debug payment form",
          agentType: "general",
          status: "error",
          startedAtMs: 100,
          completedAtMs: 400,
          lastUpdatedAtMs: 400,
          outputPreview: "Tool failed",
        },
      ],
      [
        {
          id: "task-1",
          description: "Debug payment form",
          agentType: "general",
          status: "running",
          runId: "run-retry",
          startedAtMs: 100,
          lastUpdatedAtMs: 450,
          statusText: "Running write",
        },
      ],
    );

    expect(merged[0]?.status).toBe("running");
    expect(merged[0]?.completedAtMs).toBeUndefined();
    expect(merged[0]?.outputPreview).toBeUndefined();
    expect(shouldShowTaskReasoningSummaries(merged[0]!)).toBe(true);
  });

  it("keeps a still-running thread visible when a stale live terminal overlay races the busy orchestrator", () => {
    // Repro of the sidebar bug: while the orchestrator is busy/streaming, a
    // stale live overlay reported the in-flight thread as terminal
    // (completed) even though the reload-safe persisted lifecycle still had
    // it running. `{ ...persisted, ...live }` let the live terminal status
    // win, so the row dropped out of the running list until the run went
    // idle and the overlay cleared. The persisted running truth must win.
    const persisted: TaskItem[] = [
      {
        id: "task-1",
        description: "Long background task",
        agentType: "general",
        status: "running",
        startedAtMs: 100,
        lastUpdatedAtMs: 900,
        statusText: "Working",
      },
    ];
    const staleLiveTerminal: TaskItem[] = [
      {
        id: "task-1",
        description: "Long background task",
        agentType: "general",
        status: "completed",
        runId: "run-prev",
        startedAtMs: 100,
        completedAtMs: 500,
        lastUpdatedAtMs: 500,
        outputPreview: "Stale done",
      },
    ];

    const merged = mergeFooterTasks(persisted, staleLiveTerminal);
    expect(merged[0]?.status).toBe("running");
    expect(merged[0]?.completedAtMs).toBeUndefined();
    expect(merged[0]?.outputPreview).toBeUndefined();

    // Mirror the sidebar's running/done split: the thread must land in the
    // running list (always visible), not the capped done list.
    const rows = groupActivityTasks(merged);
    const rowStatus = (row: (typeof rows)[number]) =>
      row.kind === "task" ? row.task.status : row.group.status;
    const running = rows.filter((row) => rowStatus(row) === "running");
    const done = rows.filter((row) => rowStatus(row) !== "running");
    expect(running).toHaveLength(1);
    expect(done).toHaveLength(0);
  });

  it("still lets a genuine completion terminalize once the persisted feed agrees", () => {
    // Guard against over-correcting: when the persisted lifecycle has also
    // recorded the terminal event, the row settles to done as before.
    const merged = mergeFooterTasks(
      [
        {
          id: "task-1",
          description: "Long background task",
          agentType: "general",
          status: "completed",
          startedAtMs: 100,
          completedAtMs: 900,
          lastUpdatedAtMs: 900,
          outputPreview: "Done",
        },
      ],
      [
        {
          id: "task-1",
          description: "Long background task",
          agentType: "general",
          status: "completed",
          runId: "run-1",
          startedAtMs: 100,
          completedAtMs: 900,
          lastUpdatedAtMs: 900,
          outputPreview: "Done",
        },
      ],
    );
    expect(merged[0]?.status).toBe("completed");
    expect(merged[0]?.completedAtMs).toBe(900);
  });

  it("does not let resume snapshots revive completed persisted tasks", () => {
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
          runId: "run-1",
          hydratedFromResumeSnapshot: true,
          startedAtMs: 1_000,
          lastUpdatedAtMs: 1_000,
          statusText: "Running read",
        },
      ],
    );

    expect(merged[0]?.status).toBe("completed");
    expect(merged[0]?.completedAtMs).toBe(200);
    expect(merged[0]?.outputPreview).toBe("Done");
    expect(shouldShowTaskReasoningSummaries(merged[0]!)).toBe(false);
  });

  it("does not let a hydrated terminal snapshot's timestamps beat the persisted ones", () => {
    // Regression: snapshots without real timestamps hydrate with synthetic
    // "now" stamps; letting those overwrite the persisted row bumped every
    // settled task to the same fresh instant and reordered the done list on
    // each re-hydration (message send / stream reconnect).
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
          status: "completed",
          runId: "run-1",
          hydratedFromResumeSnapshot: true,
          startedAtMs: 1_000,
          completedAtMs: 1_000,
          lastUpdatedAtMs: 1_000,
          outputPreview: "Done",
        },
      ],
    );

    expect(merged[0]?.status).toBe("completed");
    expect(merged[0]?.startedAtMs).toBe(100);
    expect(merged[0]?.completedAtMs).toBe(200);
  });

  it("keeps a live non-hydrated task's own timestamps when merging", () => {
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
          status: "completed",
          runId: "run-2",
          startedAtMs: 300,
          completedAtMs: 400,
          lastUpdatedAtMs: 400,
          outputPreview: "Done again",
        },
      ],
    );

    expect(merged[0]?.startedAtMs).toBe(300);
    expect(merged[0]?.completedAtMs).toBe(400);
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
  it("stays visible through thinking, tools and spawned agents until text starts", () => {
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

    // First visible provider delta: hand off.
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

  it("stays visible before the first visible delta arrives", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: true,
    });
    expect(props.active).toBe(true);
  });

  it("hands off on the first visible provider delta", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: true,
      isToolActive: false,
      hasToolActivity: true,
    });
    expect(props.active).toBe(false);
  });
});

describe("shouldTreatResumedAnswerAsStarted", () => {
  it("treats a resumed, already-visible answer with no live overlay as started", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(true);
  });

  it("is a no-op while a live overlay is streaming the answer", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: true,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
  });

  it("does not fire when the resumed run has no visible answer yet (still thinking)", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: false,
      }),
    ).toBe(false);
  });

  it("is a no-op once the indicator already handed off, or when no run is active", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: true,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldTreatResumedAnswerAsStarted({
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
