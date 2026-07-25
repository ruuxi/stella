import { describe, expect, it } from "vitest";
import {
  COMPACT_ACTIVITY_CELL_LIMIT,
  TASK_COMPLETION_INDICATOR_MS,
  buildActivityTasks,
  countActiveTopLevelActivityWorkUnits,
  deriveTopLevelActivityWorkUnits,
  fallbackTaskDescription,
  isActivityFeedTask,
  extractStepsFromEvents,
  getCompactActivityStatusText,
  getActivityRowStatus,
  flattenActivityTasks,
  groupActivityTasks,
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
  it("keeps only delegated General agents in the activity feed", () => {
    expect(isActivityFeedTask({ agentType: "general" })).toBe(true);
    expect(isActivityFeedTask({ agentType: "schedule" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "dream" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "explore" })).toBe(false);
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
    expect(fallbackTaskDescription("grp-abc123")).toBe("Grp abc123");
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

describe("parent agent ownership hierarchy", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("nests multiple subagents under their parent without root duplicates", () => {
    const rows = groupActivityTasks([
      task({ id: "parent", description: "Coordinate" }),
      task({ id: "research", parentAgentId: "parent" }),
      task({ id: "draft", parentAgentId: "parent", status: "completed" }),
      task({ id: "unrelated", description: "Independent" }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["hierarchy", "task"]);
    const hierarchy =
      rows[0]!.kind === "hierarchy" ? rows[0].hierarchy : undefined;
    expect(hierarchy?.status).toBe("running");
    expect(getActivityRowStatus(rows[0]!)).toBe("running");
    expect(hierarchy?.owner.id).toBe("parent");
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

  it("moves a reparented subagent beneath its parent from persisted ownership", () => {
    const parent = task({ id: "parent" });
    const nextParent = task({ id: "next-parent" });
    const child = task({ id: "adopted" });
    expect(
      groupActivityTasks([parent, nextParent, child]).map((row) => row.kind),
    ).toEqual(["task", "task", "task"]);

    const adopted = groupActivityTasks([
      parent,
      nextParent,
      { ...child, parentAgentId: parent.id, lastUpdatedAtMs: 200 },
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
      parent,
      nextParent,
      { ...child, parentAgentId: nextParent.id, lastUpdatedAtMs: 300 },
    ]);
    expect(reparented.map((row) => row.kind)).toEqual(["task", "hierarchy"]);
    if (reparented[1]?.kind === "hierarchy") {
      expect(reparented[1].hierarchy).toMatchObject({
        owner: { id: "next-parent" },
        children: [{ kind: "task", task: { id: "adopted" } }],
      });
    }
  });

  it("preserves running, paused, completed, and recursive descendant state", () => {
    const rows = groupActivityTasks([
      task({
        id: "parent",
        status: "completed",
        completedAtMs: 500,
        outputPreview: "Coordination complete",
      }),
      task({ id: "running", parentAgentId: "parent" }),
      task({ id: "paused", parentAgentId: "parent", status: "canceled" }),
      task({
        id: "complete",
        parentAgentId: "parent",
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

  it("flattens every descendant into the compact hierarchy cell model", () => {
    const rows = groupActivityTasks([
      task({ id: "parent" }),
      task({ id: "child", parentAgentId: "parent" }),
      task({ id: "grandchild", parentAgentId: "child" }),
      task({ id: "done", parentAgentId: "parent", status: "completed" }),
    ]);
    const hierarchy = rows[0];
    expect(hierarchy?.kind).toBe("hierarchy");
    if (hierarchy?.kind !== "hierarchy") return;
    expect(
      flattenActivityTasks(hierarchy.hierarchy.children).map((item) => item.id),
    ).toEqual(["child", "grandchild", "done"]);
  });
});

describe("top-level Activity work-unit counts", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: overrides.id,
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("counts a direct General plus a parent agent with an active subagent as two", () => {
    const tasks = [
      task({ id: "direct" }),
      task({ id: "parent" }),
      task({ id: "subagent", parentAgentId: "parent" }),
    ];
    expect(countActiveTopLevelActivityWorkUnits(tasks)).toBe(2);
    expect(deriveTopLevelActivityWorkUnits(tasks)).toEqual([
      { id: "task:direct", status: "running" },
      { id: "hierarchy:parent", status: "running" },
    ]);
  });

  it("counts one parent agent with eight descendants as one", () => {
    const tasks = [
      task({ id: "parent" }),
      ...Array.from({ length: 8 }, (_, index) =>
        task({ id: `child-${index}`, parentAgentId: "parent" }),
      ),
    ];
    expect(countActiveTopLevelActivityWorkUnits(tasks)).toBe(1);
  });

  it("counts two direct agents plus one parent agent as three", () => {
    expect(
      countActiveTopLevelActivityWorkUnits([
        task({ id: "direct-a" }),
        task({ id: "direct-b" }),
        task({ id: "parent" }),
      ]),
    ).toBe(3);
  });

  it("does not promote an active subagent beneath a paused parent", () => {
    const tasks = [
      task({ id: "parent", status: "canceled" }),
      task({ id: "child", parentAgentId: "parent" }),
    ];
    expect(countActiveTopLevelActivityWorkUnits(tasks)).toBe(0);
    expect(deriveTopLevelActivityWorkUnits(tasks)).toEqual([
      { id: "hierarchy:parent", status: "canceled" },
    ]);
  });

  it("keeps an active parent running when one owned subagent completes", () => {
    const tasks = [
      task({ id: "parent" }),
      task({
        id: "finished-child",
        parentAgentId: "parent",
        status: "completed",
      }),
    ];
    expect(deriveTopLevelActivityWorkUnits(tasks)).toEqual([
      { id: "hierarchy:parent", status: "running" },
    ]);
    expect(countActiveTopLevelActivityWorkUnits(tasks)).toBe(1);
  });

  it("keeps a terminal-looking parent active while owned work is running", () => {
    const tasks = [
      task({
        id: "parent",
        status: "completed",
      }),
      task({ id: "active-child", parentAgentId: "parent" }),
    ];
    expect(deriveTopLevelActivityWorkUnits(tasks)).toEqual([
      { id: "hierarchy:parent", status: "running" },
    ]);
    expect(countActiveTopLevelActivityWorkUnits(tasks)).toBe(1);
  });

  it("settles a parent row only after the owner and descendants settle", () => {
    const tasks = [
      task({
        id: "parent",
        status: "completed",
      }),
      task({
        id: "finished-child",
        parentAgentId: "parent",
        status: "completed",
      }),
    ];
    expect(deriveTopLevelActivityWorkUnits(tasks)).toEqual([
      { id: "hierarchy:parent", status: "completed" },
    ]);
    expect(countActiveTopLevelActivityWorkUnits(tasks)).toBe(0);
  });

  it("counts a nested subagent tree as one top-level unit", () => {
    expect(
      countActiveTopLevelActivityWorkUnits([
        task({ id: "root-parent" }),
        task({
          id: "nested-parent",
          parentAgentId: "root-parent",
        }),
        task({ id: "leaf", parentAgentId: "nested-parent" }),
      ]),
    ).toBe(1);
  });

  it("updates across completion, resume, reparenting, and detachment", () => {
    const parent = task({ id: "parent" });
    const direct = task({ id: "agent" });
    expect(countActiveTopLevelActivityWorkUnits([parent, direct])).toBe(2);

    const completed = { ...direct, status: "completed" as const };
    expect(countActiveTopLevelActivityWorkUnits([parent, completed])).toBe(1);

    const resumed = { ...completed, status: "running" as const };
    expect(countActiveTopLevelActivityWorkUnits([parent, resumed])).toBe(2);

    const owned = { ...resumed, parentAgentId: parent.id };
    expect(countActiveTopLevelActivityWorkUnits([parent, owned])).toBe(1);

    const pausedParent = { ...parent, status: "canceled" as const };
    expect(countActiveTopLevelActivityWorkUnits([pausedParent, owned])).toBe(0);
    expect(
      countActiveTopLevelActivityWorkUnits([
        pausedParent,
        { ...owned, parentAgentId: undefined },
      ]),
    ).toBe(1);
  });

  it("deduplicates stale retry generations by authoritative attempt and update order", () => {
    const staleRunning = task({
      id: "retried",
      attemptGeneration: 4,
      lastUpdatedAtMs: 900,
    });
    const latestCompleted = task({
      id: "retried",
      status: "completed",
      attemptGeneration: 5,
      lastUpdatedAtMs: 1_000,
    });
    expect(
      countActiveTopLevelActivityWorkUnits([
        latestCompleted,
        staleRunning,
        staleRunning,
      ]),
    ).toBe(0);

    const latestResumed = {
      ...latestCompleted,
      status: "running" as const,
      attemptGeneration: 6,
      lastUpdatedAtMs: 1_100,
    };
    expect(
      countActiveTopLevelActivityWorkUnits([
        latestCompleted,
        staleRunning,
        latestResumed,
      ]),
    ).toBe(1);
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
      "1 running · 1 done · 2 failed — latest: Working…",
    );
  });

  it("selects assistant prose by durable sequence and ignores later tool status", () => {
    const summary = summarizeCompactActivity([
      task({
        id: "older",
        assistantMessages: ["Checking sources"],
        assistantMessagesUpdatedAtMs: 200,
        assistantMessagesUpdatedSequence: 20,
        lastUpdatedAtMs: 200,
      }),
      task({
        id: "later-assistant",
        assistantMessages: ["Drafting the human-readable answer"],
        assistantMessagesUpdatedAtMs: 300,
        assistantMessagesUpdatedSequence: 21,
        startedAtMs: 150,
        lastUpdatedAtMs: 300,
      }),
      task({
        id: "later-tool-result",
        statusText: "exec_command exited 0",
        startedAtMs: 150,
        lastUpdatedAtMs: 400,
      }),
    ]);

    expect(summary.latestTask?.id).toBe("later-assistant");
    expect(summary.latestText).toBe("Drafting the human-readable answer");
    expect(getCompactActivityStatusText(summary, false)).toContain(
      "latest: Drafting the human-readable answer",
    );
    expect(getCompactActivityStatusText(summary, false)).not.toContain(
      "exec_command",
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
  it("uses verbatim assistant messages for active and completed agents", () => {
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
    // Blank-only entries are the one thing dropped.
    expect(
      getTaskAgentUpdates({
        status: "running",
        agentType: "general",
        assistantMessages: ["   ", ...assistantMessages],
      }),
    ).toEqual(assistantMessages);
    for (const status of ["completed", "error", "canceled"] as const) {
      expect(
        getTaskAgentUpdates({
          status,
          agentType: "general",
          assistantMessages,
        }),
      ).toEqual(assistantMessages);
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

  it("maps authoritative rows and ignores a leftover same-attempt running decoration on terminal rows", () => {
    const tasks = buildActivityTasks(
      [
        record(),
        record({
          threadId: "book-hotel",
          description: "Book the hotel",
          status: "completed",
          attemptGeneration: 2,
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
        // A stale same-attempt running observation cannot reopen a terminal.
        "book-hotel": {
          status: "running",
          attemptGeneration: 2,
          runId: "root-2",
          startedAtMs: 2_000,
          observedAtMs: 2_500,
          statusText: "still working",
        },
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

  it.each(["running", "completed"] as const)(
    "lets a newer live follow-up supersede a stale %s row",
    (priorStatus) => {
      const [task] = buildActivityTasks(
        [
          record({
            status: priorStatus,
            attemptGeneration: 4,
            rootRunId: "prior-root",
            completedAt: 2_000,
            updatedAt: 2_000,
            result: "Prior attempt finished",
            assistantMessages: ["Prior final answer"],
          }),
        ],
        {
          "research-flights": {
            status: "running",
            attemptGeneration: 5,
            runId: "follow-up-root",
            startedAtMs: 3_000,
            observedAtMs: 3_000,
            statusText:
              "Stop milestone spam — report only a blocker or final completion",
          },
        },
      );

      expect(task).toMatchObject({
        status: "running",
        runId: "follow-up-root",
        description:
          "Stop milestone spam — report only a blocker or final completion",
        statusText:
          "Stop milestone spam — report only a blocker or final completion",
      });
      expect(task?.completedAtMs).toBeUndefined();
      expect(task?.outputPreview).toBeUndefined();
      expect(task?.assistantMessages).toBeUndefined();
    },
  );

  it("moves completed → follow-up → completed using the latest attempt", () => {
    const stale = record({
      status: "completed",
      attemptGeneration: 4,
      rootRunId: "prior-root",
      completedAt: 2_000,
      updatedAt: 2_000,
    });
    const [active] = buildActivityTasks([stale], {
      "research-flights": {
        status: "running",
        attemptGeneration: 5,
        runId: "follow-up-root",
        startedAtMs: 3_000,
        observedAtMs: 3_000,
      },
    });
    expect(active?.status).toBe("running");

    const [done] = buildActivityTasks(
      [
        record({
          status: "completed",
          attemptGeneration: 5,
          rootRunId: "follow-up-root",
          completedAt: 4_000,
          updatedAt: 4_000,
          assistantMessages: ["Final follow-up result"],
        }),
      ],
      {
        "research-flights": {
          status: "completed",
          attemptGeneration: 5,
          runId: "follow-up-root",
          startedAtMs: 3_000,
          observedAtMs: 4_010,
        },
      },
    );
    expect(done).toMatchObject({
      status: "completed",
      assistantMessages: ["Final follow-up result"],
    });
  });

  it("moves completed → follow-up → paused without showing completion", () => {
    const [paused] = buildActivityTasks(
      [
        record({
          status: "completed",
          attemptGeneration: 4,
          rootRunId: "prior-root",
          completedAt: 2_000,
          updatedAt: 2_000,
        }),
      ],
      {
        "research-flights": {
          status: "canceled",
          attemptGeneration: 5,
          runId: "follow-up-root",
          startedAtMs: 3_000,
          observedAtMs: 3_500,
        },
      },
    );
    expect(paused?.status).toBe("canceled");
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

  it("preserves persisted ownership fields on parent and subagent rows", () => {
    const tasks = buildActivityTasks([
      record({
        threadId: "parent",
        description: "Coordinate work",
      }),
      record({
        threadId: "child",
        parentAgentId: "parent",
      }),
    ]);

    expect(tasks.find((task) => task.id === "parent")).toMatchObject({
      id: "parent",
      agentType: "general",
    });
    expect(
      tasks.find((task) => task.id === "parent")?.parentAgentId,
    ).toBeUndefined();
    expect(tasks.find((task) => task.id === "child")).toMatchObject({
      id: "child",
      parentAgentId: "parent",
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

  it("keeps a completed owner tree visible when a resumed subagent is running", () => {
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
    const parent = makeTask({
      id: "terminal-parent",
      status: "completed",
      completedAtMs: 400,
    });
    const resumed = makeTask({
      id: "resumed-subagent",
      parentAgentId: parent.id,
      status: "running",
      startedAtMs: 500,
      lastUpdatedAtMs: 500,
    });

    expect(selectFreshActivityTasks([parent, resumed], 600)).toContain(resumed);
    const [row] = groupActivityTasks([parent, resumed]);
    expect(row?.kind).toBe("hierarchy");
    expect(row && getActivityRowStatus(row)).toBe("running");
    if (row?.kind === "hierarchy") {
      expect(row.hierarchy.owner.id).toBe(parent.id);
      expect(row.hierarchy.children).toMatchObject([
        { kind: "task", task: { id: resumed.id, status: "running" } },
      ]);
    }

    const settledRows = groupActivityTasks([
      parent,
      {
        ...resumed,
        status: "completed",
        completedAtMs: 700,
        lastUpdatedAtMs: 700,
      },
    ]);
    expect(getActivityRowStatus(settledRows[0]!)).toBe("completed");
  });
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
