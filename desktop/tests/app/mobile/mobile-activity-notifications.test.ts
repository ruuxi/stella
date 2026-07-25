import { describe, expect, it } from "vitest";
import {
  collectActivityNotificationKinds,
  selectActivityNotificationTasks,
  type TaskNotificationRecord,
} from "@/global/mobile/MobileActivityNotificationsBridge";
import type { TaskItem } from "@/features/chat/lib/event-transforms";

const task = (id: string, overrides: Partial<TaskItem> = {}): TaskItem => ({
  id,
  description: `Task ${id}`,
  agentType: "general",
  status: "running",
  startedAtMs: 1_000,
  lastUpdatedAtMs: 1_000,
  ...overrides,
});

const selectedIds = (tasks: readonly TaskItem[]): string[] =>
  selectActivityNotificationTasks(tasks).map((entry) => entry.id);

describe("mobile Activity notification ownership", () => {
  it("notifies only for root-spawned General agents", () => {
    const tasks = [
      task("root-general"),
      task("subagent-general", { parentAgentId: "root-general" }),
      task("reserved-builtin", { agentType: "explore" }),
    ];

    expect(selectedIds(tasks)).toEqual(["root-general"]);
  });

  it("never notifies for a General subagent, whoever its parent is", () => {
    // Hard product invariant: a subagent's completion is delivered into its
    // parent's thread and must not reach the user as a notification. The
    // Activity feed omits the Orchestrator, so any parent id at all — resolved
    // in the feed or not — means this row is somebody else's business.
    const tasks = [
      task("root-general"),
      task("child", { parentAgentId: "root-general" }),
      task("grandchild", { parentAgentId: "child" }),
      task("orchestrator-spawned", {
        parentAgentId: "orchestrator-thread-not-in-activity",
      }),
    ];

    expect(selectedIds(tasks)).toEqual(["root-general"]);
  });

  it("applies the subagent suppression regardless of status or attempt", () => {
    const root = task("root-general");
    const standalone = task("worker");
    expect(selectedIds([root, standalone])).toEqual(["root-general", "worker"]);

    const adopted = task("worker", {
      parentAgentId: "root-general",
      status: "completed",
      completedAtMs: 2_000,
      lastUpdatedAtMs: 2_000,
    });
    const resumed = task("worker", {
      parentAgentId: "root-general",
      status: "running",
      attemptGeneration: 2,
      lastUpdatedAtMs: 3_000,
    });

    expect(selectedIds([root, adopted])).toEqual(["root-general"]);
    expect(selectedIds([root, resumed])).toEqual(["root-general"]);
  });

  it("fails closed for malformed ids, duplicates, and any parented row", () => {
    const tasks = [
      task("parented-builtin", {
        agentType: "explore",
        parentAgentId: "unexpected-parent",
      }),
      task("self-parent", { parentAgentId: "self-parent" }),
      task("whitespace-parent", { parentAgentId: "  " }),
      task("cycle-a", { parentAgentId: "cycle-b" }),
      task("cycle-b", { parentAgentId: "cycle-a" }),
      task("broken-child", { parentAgentId: "broken-parent" }),
      task("broken-parent", { parentAgentId: "missing-after-resolved-edge" }),
      task(" untrimmed-id "),
      task(""),
      task("duplicate"),
      task("duplicate", { status: "completed" }),
      task("duplicate-child", { parentAgentId: "duplicate" }),
      task("clean-root"),
    ];

    // Only the well-formed, unduplicated, unparented General row survives.
    expect(selectedIds(tasks)).toEqual(["clean-root"]);
  });

  it("notifies each newer attempt once without weakening remount grace", () => {
    const records = new Map<string, TaskNotificationRecord>();
    const mountedAtMs = 10_000;
    const generationOne = task("worker", {
      status: "completed",
      attemptGeneration: 1,
      startedAtMs: 1_000,
      completedAtMs: 10_500,
      lastUpdatedAtMs: 10_500,
    });
    const generationTwoRunning = task("worker", {
      status: "running",
      attemptGeneration: 2,
      startedAtMs: 1_000,
      lastUpdatedAtMs: 11_000,
    });
    const generationTwoCompleted = task("worker", {
      status: "completed",
      attemptGeneration: 2,
      startedAtMs: 1_000,
      completedAtMs: 12_000,
      lastUpdatedAtMs: 12_000,
    });

    expect(
      collectActivityNotificationKinds([generationOne], records, mountedAtMs),
    ).toEqual(["completed"]);
    expect(
      collectActivityNotificationKinds(
        [generationTwoRunning],
        records,
        mountedAtMs,
      ),
    ).toEqual(["started"]);
    expect(
      collectActivityNotificationKinds(
        [generationTwoRunning],
        records,
        mountedAtMs,
      ),
    ).toEqual([]);
    expect(
      collectActivityNotificationKinds(
        [generationTwoCompleted],
        records,
        mountedAtMs,
      ),
    ).toEqual(["completed"]);
    expect(
      collectActivityNotificationKinds(
        [generationTwoCompleted],
        records,
        mountedAtMs,
      ),
    ).toEqual([]);
    expect(
      collectActivityNotificationKinds([generationOne], records, mountedAtMs),
    ).toEqual([]);

    const remountedRecords = new Map<string, TaskNotificationRecord>();
    expect(
      collectActivityNotificationKinds(
        [generationTwoRunning],
        remountedRecords,
        mountedAtMs,
      ),
    ).toEqual([]);
  });
});
