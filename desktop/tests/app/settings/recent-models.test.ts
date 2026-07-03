import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRecentModelRows,
  createKnownModelIdPredicate,
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

  it("recognizes BYOK and local ids against the full merged catalog", () => {
    // The id set must be built from allModels (merged catalog) — a
    // Stella-only set would prune valid BYOK/local picks (regression).
    const mergedCatalog = new Set([
      "stella/designer",
      "openrouter/qwen-3-coder",
      "anthropic/claude-opus-4-5",
      "local/http%3A%2F%2Flocalhost%3A1234/qwen2.5",
    ]);
    const isKnown = createKnownModelIdPredicate(mergedCatalog);
    expect(isKnown("openrouter/qwen-3-coder")).toBe(true);
    expect(isKnown("anthropic/claude-opus-4-5")).toBe(true);
    expect(isKnown("local/http%3A%2F%2Flocalhost%3A1234/qwen2.5")).toBe(true);
    expect(isKnown("openrouter/removed-model")).toBe(false);

    // Engine aliases resolve at run time; valid regardless of catalog.
    expect(isKnown("claude-code/opus")).toBe(true);
    expect(isKnown("codex-cli/gpt-5.5")).toBe(true);

    // Empty set = catalog not loaded: validation suspended.
    const unloaded = createKnownModelIdPredicate(new Set());
    expect(unloaded("openrouter/anything")).toBe(true);
  });

  it("keeps BYOK and local recents when pruning against the merged catalog", () => {
    recordRecentModel("local/http%3A%2F%2Flocalhost%3A1234/qwen2.5");
    recordRecentModel("openrouter/qwen-3-coder");
    recordRecentModel("openrouter/removed-model");
    const isKnown = createKnownModelIdPredicate(
      new Set([
        "openrouter/qwen-3-coder",
        "local/http%3A%2F%2Flocalhost%3A1234/qwen2.5",
      ]),
    );
    expect(pruneRecentModels(isKnown)).toEqual([
      "openrouter/qwen-3-coder",
      "local/http%3A%2F%2Flocalhost%3A1234/qwen2.5",
    ]);
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
