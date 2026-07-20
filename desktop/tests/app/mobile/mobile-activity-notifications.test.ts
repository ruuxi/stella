import { describe, expect, it } from "vitest";
import {
  collectActivityNotificationKinds,
  selectActivityNotificationTasks,
  type TaskNotificationRecord,
} from "@/global/mobile/MobileActivityNotificationsBridge";
import type { TaskItem } from "@/features/chat/lib/event-transforms";

const task = (
  id: string,
  overrides: Partial<TaskItem> = {},
): TaskItem => ({
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
  it("keeps Manager and standalone General notifications", () => {
    const tasks = [
      task("manager", { agentType: "manager" }),
      task("standalone-no-parent"),
      task("standalone-orchestrator-parent", {
        parentAgentId: "orchestrator-thread-not-in-activity",
      }),
    ];

    expect(selectedIds(tasks)).toEqual([
      "manager",
      "standalone-no-parent",
      "standalone-orchestrator-parent",
    ]);
  });

  it("suppresses every General descendant of a Manager", () => {
    const tasks = [
      task("manager", { agentType: "manager" }),
      task("managed-child", { parentAgentId: "manager" }),
      task("managed-descendant", { parentAgentId: "managed-child" }),
      task("standalone", { parentAgentId: "orchestrator-thread" }),
    ];

    expect(selectedIds(tasks)).toEqual(["manager", "standalone"]);
  });

  it("applies durable adoption and resume ancestry regardless of status", () => {
    const manager = task("manager", { agentType: "manager" });
    const standalone = task("worker", {
      parentAgentId: "orchestrator-thread",
    });
    expect(selectedIds([manager, standalone])).toEqual(["manager", "worker"]);

    const adopted = task("worker", {
      parentAgentId: "manager",
      status: "completed",
      completedAtMs: 2_000,
      lastUpdatedAtMs: 2_000,
    });
    const resumed = task("worker", {
      parentAgentId: "manager",
      status: "running",
      attemptGeneration: 2,
      lastUpdatedAtMs: 3_000,
    });

    expect(selectedIds([manager, adopted])).toEqual(["manager"]);
    expect(selectedIds([manager, resumed])).toEqual(["manager"]);
  });

  it("fails closed for malformed, duplicate, cyclic, and broken ancestry", () => {
    const tasks = [
      task("parented-manager", {
        agentType: "manager",
        parentAgentId: "unexpected-parent",
      }),
      task("self-parent", { parentAgentId: "self-parent" }),
      task("whitespace-parent", { parentAgentId: "  " }),
      task("cycle-a", { parentAgentId: "cycle-b" }),
      task("cycle-b", { parentAgentId: "cycle-a" }),
      task("broken-child", { parentAgentId: "broken-parent" }),
      task("broken-parent", { parentAgentId: "missing-after-resolved-edge" }),
      task("duplicate"),
      task("duplicate", { status: "completed" }),
      task("duplicate-child", { parentAgentId: "duplicate" }),
    ];

    // The unresolved first edge is the expected omitted-Orchestrator boundary.
    // Its child has already resolved an Activity parent, so that same missing
    // edge is unsafe ancestry for the child and must suppress it.
    expect(selectedIds(tasks)).toEqual(["broken-parent"]);
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
      collectActivityNotificationKinds(
        [generationOne],
        records,
        mountedAtMs,
      ),
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
      collectActivityNotificationKinds(
        [generationOne],
        records,
        mountedAtMs,
      ),
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
