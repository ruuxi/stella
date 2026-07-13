import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { buildCompletedActivityList } from "@/shell/display/activity-history-model";

const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
  description: overrides.id,
  agentType: "general",
  status: "completed",
  startedAtMs: 100,
  lastUpdatedAtMs: 200,
  completedAtMs: 200,
  ...overrides,
});

describe("completed activity hierarchy", () => {
  it("keeps a completed manager, its children, and recursive descendants together", () => {
    const items = buildCompletedActivityList([
      task({
        id: "manager",
        agentType: "manager",
        outputPreview: "All work complete",
      }),
      task({ id: "one", parentAgentId: "manager" }),
      task({ id: "two", parentAgentId: "manager", status: "canceled" }),
      task({ id: "nested", parentAgentId: "one", status: "error" }),
    ]);

    expect(items.map((item) => [item.kind, item.depth])).toEqual([
      ["doneHierarchy", 0],
      ["doneHierarchy", 1],
      ["done", 2],
      ["done", 1],
    ]);
    expect(items[0]).toMatchObject({
      hierarchy: {
        owner: { id: "manager", outputPreview: "All work complete" },
      },
    });
    expect(
      items.filter((item) => item.kind === "done" && item.task.id === "two"),
    ).toHaveLength(1);
  });

  it("does not orphan a completed child while its manager is still running", () => {
    const items = buildCompletedActivityList([
      task({ id: "manager", agentType: "manager", status: "running" }),
      task({ id: "done-child", parentAgentId: "manager" }),
    ]);
    expect(items).toEqual([]);
  });

  it("keeps legacy groups unchanged and searchable through their members", () => {
    const items = buildCompletedActivityList(
      [
        task({ id: "one", groupKey: "trip", groupLabel: "Plan trip" }),
        task({
          id: "two",
          description: "Compare trains",
          groupKey: "trip",
          groupLabel: "Plan trip",
        }),
      ],
      "trains",
    );

    expect(items.map((item) => [item.kind, item.depth])).toEqual([
      ["doneGroup", 0],
      ["done", 1],
      ["done", 1],
    ]);
  });
});
