import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVITY_EXPANSION,
  activityExpansionStore,
} from "@/shell/activity-expansion-store";
import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella.sidebar.activityExpansion";

const snapshot = (suffix: string) => ({
  seenTaskIds: [`task-${suffix}`],
  taskOverrides: { [`task-${suffix}`]: false },
});

describe("activity expansion store", () => {
  beforeEach(() => {
    uiState.removeItem(STORAGE_KEY);
  });

  it("returns the empty snapshot for unknown conversations", () => {
    expect(activityExpansionStore.load("conv-a")).toEqual(
      EMPTY_ACTIVITY_EXPANSION,
    );
  });

  it("round-trips a saved snapshot per conversation", () => {
    activityExpansionStore.save("conv-a", snapshot("a"));
    activityExpansionStore.save("conv-b", snapshot("b"));

    expect(activityExpansionStore.load("conv-a")).toMatchObject(snapshot("a"));
    expect(activityExpansionStore.load("conv-b")).toMatchObject(snapshot("b"));
  });

  it("caps persisted conversations, evicting least-recently saved", () => {
    for (let index = 0; index < 10; index += 1) {
      activityExpansionStore.save(`conv-${index}`, snapshot(String(index)));
    }
    // First two saves are the oldest and fall out of the LRU cap of 8.
    expect(activityExpansionStore.load("conv-0")).toEqual(
      EMPTY_ACTIVITY_EXPANSION,
    );
    expect(activityExpansionStore.load("conv-1")).toEqual(
      EMPTY_ACTIVITY_EXPANSION,
    );
    expect(activityExpansionStore.load("conv-9")).toMatchObject(snapshot("9"));
  });

  it("ignores malformed persisted payloads", () => {
    uiState.setItem(STORAGE_KEY, "not json");
    expect(activityExpansionStore.load("conv-a")).toEqual(
      EMPTY_ACTIVITY_EXPANSION,
    );

    uiState.setItem(
      STORAGE_KEY,
      JSON.stringify({ "conv-a": { seenTaskIds: "nope" } }),
    );
    expect(activityExpansionStore.load("conv-a")).toEqual(
      EMPTY_ACTIVITY_EXPANSION,
    );

    // A valid entry next to a broken one still loads.
    uiState.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "conv-broken": { seenTaskIds: 42 },
        "conv-a": { ...snapshot("a"), updatedAt: 1 },
      }),
    );
    expect(activityExpansionStore.load("conv-a")).toMatchObject(snapshot("a"));
    expect(activityExpansionStore.load("conv-broken")).toEqual(
      EMPTY_ACTIVITY_EXPANSION,
    );
  });
});
