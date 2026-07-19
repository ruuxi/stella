import { describe, expect, it } from "vitest";
import {
  COMPACT_ACTIVITY_CELL_LIMIT,
  TASK_COMPLETION_INDICATOR_MS,
  buildActivityTasks,
  fallbackTaskDescription,
  isActivityFeedTask,
  extractStepsFromEvents,
  getCompactActivityStatusText,
  getActivityRowStatus,
  flattenActivityTasks,
  groupActivityTasks,
  pruneGroupExpandOverrides,
  selectFreshActivityTasks,
  summarizeCompactActivity,
  getTaskAgentUpdates,
  updateSeenRunningTaskIds,
  type EventRecord,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import type { ThreadActivityRecord } from "../../../../runtime/contracts/local-chat.js";
import {
  buildInlineWorkingIndicatorProps,
  getInlineWorkingIndicatorActive,
  getInlineWorkingIndicatorExitDelayMs,
  shouldTreatResumedAnswerAsStarted,
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
  it("keeps delegated agents and managers in the activity feed", () => {
    expect(isActivityFeedTask({ agentType: "general" })).toBe(true);
    expect(isActivityFeedTask({ agentType: "manager" })).toBe(true);
    expect(isActivityFeedTask({ agentType: "schedule" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "dream" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "orchestrator" })).toBe(false);
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

  it("aggregates running, completed, and failed group state", () => {
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
  });
});

describe("manager ownership hierarchy", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("nests multiple owned agents under their manager without root duplicates", () => {
    const rows = groupActivityTasks([
      task({ id: "manager", agentType: "manager", description: "Coordinate" }),
      task({ id: "research", parentAgentId: "manager" }),
      task({ id: "draft", parentAgentId: "manager", status: "completed" }),
      task({ id: "unrelated", description: "Independent" }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["hierarchy", "task"]);
    const hierarchy =
      rows[0]!.kind === "hierarchy" ? rows[0].hierarchy : undefined;
    expect(hierarchy?.status).toBe("running");
    expect(getActivityRowStatus(rows[0]!)).toBe("running");
    expect(hierarchy?.owner.id).toBe("manager");
    expect(
      hierarchy?.children.map((row) =>
        row.kind === "task" ? [row.task.id, row.task.status] : [row.kind],
      ),
    ).toEqual([
      ["research", "running"],
      ["draft", "completed"],
    ]);
    expect(hierarchy?.descendantCount).toBe(2);
    expect(
      rows.some((row) => row.kind === "task" && row.task.id === "research"),
    ).toBe(false);
  });

  it("moves an adopted agent beneath the manager from persisted ownership", () => {
    const manager = task({ id: "manager", agentType: "manager" });
    const nextManager = task({ id: "next-manager", agentType: "manager" });
    const child = task({ id: "adopted" });
    expect(
      groupActivityTasks([manager, nextManager, child]).map((row) => row.kind),
    ).toEqual(["task", "task", "task"]);

    const adopted = groupActivityTasks([
      manager,
      nextManager,
      { ...child, parentAgentId: manager.id, lastUpdatedAtMs: 200 },
    ]);
    expect(adopted).toHaveLength(2);
    expect(adopted[0]?.kind).toBe("hierarchy");
    if (adopted[0]?.kind === "hierarchy") {
      expect(adopted[0].hierarchy.children[0]).toMatchObject({
        kind: "task",
        task: { id: "adopted" },
      });
    }

    const reparented = groupActivityTasks([
      manager,
      nextManager,
      { ...child, parentAgentId: nextManager.id, lastUpdatedAtMs: 300 },
    ]);
    expect(reparented.map((row) => row.kind)).toEqual(["task", "hierarchy"]);
    if (reparented[1]?.kind === "hierarchy") {
      expect(reparented[1].hierarchy).toMatchObject({
        owner: { id: "next-manager" },
        children: [{ kind: "task", task: { id: "adopted" } }],
      });
    }
  });

  it("preserves running, paused, completed, and recursive descendant state", () => {
    const rows = groupActivityTasks([
      task({
        id: "manager",
        agentType: "manager",
        status: "completed",
        completedAtMs: 500,
        outputPreview: "Coordination complete",
      }),
      task({ id: "running", parentAgentId: "manager" }),
      task({ id: "paused", parentAgentId: "manager", status: "canceled" }),
      task({
        id: "complete",
        parentAgentId: "manager",
        status: "completed",
      }),
      task({ id: "descendant", parentAgentId: "running", status: "error" }),
    ]);

    expect(rows).toHaveLength(1);
    const hierarchy =
      rows[0]!.kind === "hierarchy" ? rows[0].hierarchy : undefined;
    expect(hierarchy?.owner).toMatchObject({
      status: "completed",
      outputPreview: "Coordination complete",
    });
    expect(hierarchy?.descendantCount).toBe(4);
    expect(
      hierarchy?.children.map((row) =>
        row.kind === "hierarchy"
          ? [row.hierarchy.owner.id, row.hierarchy.owner.status]
          : row.kind === "task"
            ? [row.task.id, row.task.status]
            : [row.kind],
      ),
    ).toEqual([
      ["running", "running"],
      ["paused", "canceled"],
      ["complete", "completed"],
    ]);
    const nested = hierarchy?.children[0];
    expect(nested?.kind).toBe("hierarchy");
    if (nested?.kind === "hierarchy") {
      expect(nested.hierarchy.children[0]).toMatchObject({
        kind: "task",
        task: { id: "descendant", status: "error" },
      });
    }
  });

  it("flattens every descendant into the compact manager cell model", () => {
    const rows = groupActivityTasks([
      task({ id: "manager", agentType: "manager" }),
      task({ id: "child", parentAgentId: "manager" }),
      task({ id: "grandchild", parentAgentId: "child" }),
      task({ id: "done", parentAgentId: "manager", status: "completed" }),
    ]);
    const hierarchy = rows[0];
    expect(hierarchy?.kind).toBe("hierarchy");
    if (hierarchy?.kind !== "hierarchy") return;
    expect(
      flattenActivityTasks(hierarchy.hierarchy.children).map((item) => item.id),
    ).toEqual(["child", "grandchild", "done"]);
  });
});

describe("compact activity summary", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: overrides.id,
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("keeps running and done counts visible while failure wording wins", () => {
    const summary = summarizeCompactActivity([
      task({
        id: "running",
        statusText: "Still working",
        lastUpdatedAtMs: 400,
      }),
      task({
        id: "failed-old",
        description: "Review round 3",
        status: "error",
        lastUpdatedAtMs: 250,
      }),
      task({
        id: "failed",
        description: "Review round 4",
        status: "error",
        lastUpdatedAtMs: 300,
      }),
      task({ id: "done", status: "completed", lastUpdatedAtMs: 200 }),
    ]);

    expect(getCompactActivityStatusText(summary, true)).toBe(
      "2 failed — Review round 4 · 1 running · 1 done",
    );
    expect(getCompactActivityStatusText(summary, false)).toBe(
      "1 running · 1 done · 2 failed — latest: Still working",
    );
  });

  it("selects the newest child update with deterministic timestamp ties", () => {
    const summary = summarizeCompactActivity([
      task({
        id: "older",
        statusText: "Checking sources",
        lastUpdatedAtMs: 200,
      }),
      task({
        id: "z-later-start",
        statusText: "Drafting answer",
        startedAtMs: 150,
        lastUpdatedAtMs: 300,
      }),
      task({
        id: "a-later-start",
        statusText: "Verifying answer",
        startedAtMs: 150,
        lastUpdatedAtMs: 300,
      }),
    ]);

    expect(summary.latestTask?.id).toBe("a-later-start");
    expect(summary.latestText).toBe("Verifying answer");
    expect(getCompactActivityStatusText(summary, false)).toContain(
      "latest: Verifying answer",
    );
  });

  it("switches to the progress-bar model only after sixteen children", () => {
    const atLimit = Array.from(
      { length: COMPACT_ACTIVITY_CELL_LIMIT },
      (_, index) => task({ id: `task-${index}` }),
    );
    expect(summarizeCompactActivity(atLimit).usesProgressBar).toBe(false);
    expect(
      summarizeCompactActivity([...atLimit, task({ id: "overflow" })])
        .usesProgressBar,
    ).toBe(true);
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

describe("getTaskAgentUpdates", () => {
  it("uses verbatim assistant messages only while a non-manager agent is running", () => {
    const assistantMessages = [
      "I checked the exact route.\nNo rewrite was needed.",
      "The focused tests now pass.",
    ];
    expect(
      getTaskAgentUpdates({
        status: "running",
        agentType: "general",
        assistantMessages,
      }),
    ).toEqual(assistantMessages);
    expect(
      getTaskAgentUpdates({
        status: "running",
        agentType: "manager",
        assistantMessages,
      }),
    ).toEqual([]);
    for (const status of ["completed", "error", "canceled"] as const) {
      expect(
        getTaskAgentUpdates({
          status,
          agentType: "general",
          assistantMessages,
        }),
      ).toEqual([]);
    }
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
});

describe("buildActivityTasks", () => {
  const record = (
    overrides: Partial<ThreadActivityRecord> = {},
  ): ThreadActivityRecord => ({
    threadId: "research-flights",
    conversationId: "conv-1",
    agentType: "general",
    description: "Research flights",
    status: "running",
    startedAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  });

  it("maps authoritative rows and overlays decoration only on running rows", () => {
    const tasks = buildActivityTasks(
      [
        record(),
        record({
          threadId: "book-hotel",
          description: "Book the hotel",
          status: "completed",
          rootRunId: "root-2",
          startedAt: 2_000,
          completedAt: 3_000,
          updatedAt: 3_000,
          result: "Booked the Marriott",
        }),
      ],
      {
        "research-flights": {
          statusText: "Comparing fares",
          reasoningText: "checking SAS…",
        },
        // Decoration for a terminal row must be ignored entirely — a stale
        // "running" leftover can never re-open a finished thread.
        "book-hotel": { statusText: "still working" },
      },
    );

    expect(tasks).toHaveLength(2);
    const [running, done] = tasks;
    expect(running).toMatchObject({
      id: "research-flights",
      status: "running",
      description: "Research flights",
      statusText: "Comparing fares",
      reasoningText: "checking SAS…",
    });
    expect(done).toMatchObject({
      id: "book-hotel",
      status: "completed",
      description: "Book the hotel",
      runId: "root-2",
      completedAtMs: 3_000,
      outputPreview: "Booked the Marriott",
    });
    expect(done?.statusText).toBeUndefined();
    expect(done?.reasoningText).toBeUndefined();
  });

  it("shows the row's own description: a send_input follow-up that re-described the thread just shows the new text", () => {
    // The regression this architecture removes: the folded sidebar row kept
    // the original spawn description after a follow-up. Rows carry the
    // runtime's current description, so there is nothing to reconcile.
    const tasks = buildActivityTasks([
      record({ description: "Search for the itinerary email" }),
    ]);
    expect(tasks[0]?.description).toBe("Search for the itinerary email");
  });

  it("falls back to the description as statusText for running rows without decoration", () => {
    const tasks = buildActivityTasks([record()]);
    expect(tasks[0]?.statusText).toBe("Research flights");
  });

  it("projects agent-authored assistant messages without rewriting them", () => {
    const assistantMessages = ["First line\n\nSecond paragraph."];
    const tasks = buildActivityTasks([record({ assistantMessages })]);
    expect(tasks[0]?.assistantMessages).toEqual(assistantMessages);
  });

  it("excludes orchestrator-internal helper agents", () => {
    const tasks = buildActivityTasks([
      record({ threadId: "helper", agentType: "schedule" }),
      record(),
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["research-flights"]);
  });

  it("includes managers and preserves persisted ownership fields", () => {
    const tasks = buildActivityTasks([
      record({
        threadId: "manager",
        agentType: "manager",
        description: "Coordinate work",
      }),
      record({
        threadId: "child",
        parentAgentId: "manager",
        groupKey: "legacy-group",
        groupLabel: "Legacy group",
      }),
    ]);

    expect(tasks.find((task) => task.id === "manager")).toMatchObject({
      id: "manager",
      agentType: "manager",
    });
    expect(tasks.find((task) => task.id === "child")).toMatchObject({
      id: "child",
      parentAgentId: "manager",
      groupKey: "legacy-group",
      groupLabel: "Legacy group",
    });
  });

  it("surfaces the error text as the preview for failed rows", () => {
    const tasks = buildActivityTasks([
      record({
        status: "error",
        completedAt: 2_000,
        updatedAt: 2_000,
        error: "Mailbox unreachable",
      }),
    ]);
    expect(tasks[0]).toMatchObject({
      status: "error",
      outputPreview: "Mailbox unreachable",
    });
  });

  it("orders by started time with id tie-break", () => {
    const tasks = buildActivityTasks([
      record({ threadId: "b-second", startedAt: 2_000 }),
      record({ threadId: "a-first", startedAt: 1_000 }),
      record({ threadId: "a-also-second", startedAt: 2_000 }),
    ]);
    expect(tasks.map((task) => task.id)).toEqual([
      "a-first",
      "a-also-second",
      "b-second",
    ]);
  });

  it.each(["general", "manager"] as const)(
    "keeps a terminal owner tree visible when a resumed %s descendant is running",
    (agentType) => {
      const makeTask = (
        overrides: Partial<TaskItem> & { id: string },
      ): TaskItem => ({
        description: "Task",
        agentType: "general",
        status: "running",
        startedAtMs: 100,
        lastUpdatedAtMs: 100,
        ...overrides,
      });
      const manager = makeTask({
        id: "terminal-manager",
        agentType: "manager",
        status: "completed",
        completedAtMs: 400,
      });
      const resumed = makeTask({
        id: `resumed-${agentType}`,
        agentType,
        parentAgentId: manager.id,
        status: "running",
        startedAtMs: 500,
        lastUpdatedAtMs: 500,
      });

      expect(selectFreshActivityTasks([manager, resumed], 600)).toContain(
        resumed,
      );
      const [row] = groupActivityTasks([manager, resumed]);
      expect(row?.kind).toBe("hierarchy");
      expect(row && getActivityRowStatus(row)).toBe("running");
      if (row?.kind === "hierarchy") {
        expect(row.hierarchy.owner.id).toBe(manager.id);
        expect(row.hierarchy.children).toMatchObject([
          { kind: "task", task: { id: resumed.id, status: "running" } },
        ]);
      }

      const settledRows = groupActivityTasks([
        manager,
        {
          ...resumed,
          status: "completed",
          completedAtMs: 700,
          lastUpdatedAtMs: 700,
        },
      ]);
      expect(getActivityRowStatus(settledRows[0]!)).toBe("completed");
    },
  );
});

describe("selectFreshActivityTasks", () => {
  const task = (overrides: Partial<TaskItem>): TaskItem => ({
    id: "t",
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 0,
    lastUpdatedAtMs: 0,
    ...overrides,
  });

  it("keeps running rows and recently-finished rows, drops old history", () => {
    const nowMs = 100_000;
    const fresh = selectFreshActivityTasks(
      [
        task({ id: "running" }),
        task({
          id: "just-done",
          status: "completed",
          completedAtMs: nowMs - TASK_COMPLETION_INDICATOR_MS + 500,
        }),
        task({ id: "old-done", status: "completed", completedAtMs: 1_000 }),
        task({ id: "old-error", status: "error", completedAtMs: 2_000 }),
      ],
      nowMs,
    );
    expect(fresh.map((entry) => entry.id)).toEqual(["running", "just-done"]);
  });
});
