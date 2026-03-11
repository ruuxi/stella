import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "../../../../src/app/home/schedule-item";
import { sortActivityItems } from "../../../../src/app/home/activity-order";

afterEach(() => {
  vi.useRealTimers();
});

describe("sortActivityItems", () => {
  it("pulls imminent scheduled work above stale history", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));

    const items: ActivityItem[] = [
      {
        id: "task-old",
        kind: "task",
        name: "Old task",
        lastRunAtMs: Date.parse("2026-03-08T12:00:00.000Z"),
      },
      {
        id: "schedule-soon",
        kind: "scheduled",
        name: "Soon automation",
        enabled: true,
        nextRunAtMs: Date.parse("2026-03-11T12:05:00.000Z"),
        lastRunAtMs: Date.parse("2026-03-01T12:00:00.000Z"),
      },
    ];

    expect(sortActivityItems(items).map((item) => item.id)).toEqual([
      "schedule-soon",
      "task-old",
    ]);
  });

  it("keeps recent task activity above far-future schedules", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));

    const items: ActivityItem[] = [
      {
        id: "task-recent",
        kind: "task",
        name: "Recent task",
        lastRunAtMs: Date.parse("2026-03-11T11:55:00.000Z"),
      },
      {
        id: "schedule-later",
        kind: "scheduled",
        name: "Later automation",
        enabled: true,
        nextRunAtMs: Date.parse("2026-03-13T12:00:00.000Z"),
        lastRunAtMs: Date.parse("2026-03-01T12:00:00.000Z"),
      },
    ];

    expect(sortActivityItems(items).map((item) => item.id)).toEqual([
      "task-recent",
      "schedule-later",
    ]);
  });

  it("orders upcoming schedules by the nearest next run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));

    const items: ActivityItem[] = [
      {
        id: "schedule-later",
        kind: "scheduled",
        name: "Later automation",
        enabled: true,
        nextRunAtMs: Date.parse("2026-03-11T14:00:00.000Z"),
      },
      {
        id: "schedule-soon",
        kind: "monitoring",
        name: "Soon monitor",
        enabled: true,
        nextRunAtMs: Date.parse("2026-03-11T12:15:00.000Z"),
      },
    ];

    expect(sortActivityItems(items).map((item) => item.id)).toEqual([
      "schedule-soon",
      "schedule-later",
    ]);
  });
});
