import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRecentModelRows,
  pruneRecentModels,
  readRecentModels,
  recordRecentModel,
} from "@/global/settings/lib/recent-models";
import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:recent-models";

describe("recent models", () => {
  beforeEach(() => {
    uiState.removeItem(STORAGE_KEY);
  });

  it("records picks newest-first, deduped and bounded", () => {
    recordRecentModel("stella/designer");
    recordRecentModel("openrouter/qwen-3");
    recordRecentModel("stella/designer");
    expect(readRecentModels()).toEqual(["stella/designer", "openrouter/qwen-3"]);

    for (let index = 0; index < 10; index += 1) {
      recordRecentModel(`stella/model-${index}`);
    }
    expect(readRecentModels()).toHaveLength(8);
    expect(readRecentModels()[0]).toBe("stella/model-9");
  });

  it("ignores empty ids and corrupt storage", () => {
    expect(recordRecentModel("   ")).toEqual([]);
    uiState.setItem(STORAGE_KEY, "{not json");
    expect(readRecentModels()).toEqual([]);
  });

  it("prunes ids that no longer resolve and persists the result", () => {
    recordRecentModel("openrouter/gone");
    recordRecentModel("stella/designer");
    const survivors = pruneRecentModels((id) => id !== "openrouter/gone");
    expect(survivors).toEqual(["stella/designer"]);
    expect(readRecentModels()).toEqual(["stella/designer"]);
  });

  it("builds recent rows with the current selection pinned first", () => {
    const rows = buildRecentModelRows({
      currentId: "claude-code/opus",
      recentIds: ["openrouter/qwen-3", "claude-code/opus", "stella/designer"],
      excludeIds: new Set(["stella/designer"]),
      isKnownModelId: () => true,
    });
    expect(rows).toEqual([
      { id: "claude-code/opus" },
      { id: "openrouter/qwen-3" },
    ]);
  });

  it("keeps a stale current selection visible but flags it unavailable", () => {
    const rows = buildRecentModelRows({
      currentId: "openrouter/disconnected",
      recentIds: ["openrouter/disconnected", "openrouter/also-gone", "stella/x"],
      excludeIds: new Set<string>(),
      isKnownModelId: (id) => id === "stella/x",
    });
    // The pinned current stays (disabled); stale non-current recents drop.
    expect(rows).toEqual([
      { id: "openrouter/disconnected", unavailable: true },
      { id: "stella/x" },
    ]);
  });

  it("caps rows at the limit including the pinned current", () => {
    const rows = buildRecentModelRows({
      currentId: "a",
      recentIds: ["b", "c", "d", "e", "f"],
      excludeIds: new Set<string>(),
      isKnownModelId: () => true,
    });
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("omits the current slot when nothing is selected", () => {
    const rows = buildRecentModelRows({
      currentId: "",
      recentIds: ["b"],
      excludeIds: new Set<string>(),
      isKnownModelId: () => true,
    });
    expect(rows).toEqual([{ id: "b" }]);
  });
});
