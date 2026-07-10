import { describe, expect, it } from "vitest";
import {
  computeStateDiff,
  formatStateDiffBlock,
  shouldUseDiffOnly,
  type StateDiffTarget,
} from "../../../../../runtime/kernel/cli/stella-computer-state-diff.js";

const target = (overrides: Partial<StateDiffTarget> = {}): StateDiffTarget => ({
  appName: "Spotify",
  bundleId: "com.spotify.client",
  pid: 42,
  windowId: 7,
  capturedAt: "2026-07-09T00:00:00Z",
  nodeCount: 3,
  lineCount: 3,
  ...overrides,
});

describe("computeStateDiff", () => {
  it("requires a full state for a baseline or changed target", () => {
    const baseline = computeStateDiff({
      currentLines: ["a"],
      currentTarget: target(),
    });
    const changedTarget = computeStateDiff({
      previousLines: ["a"],
      currentLines: ["b"],
      previousTarget: target(),
      currentTarget: target({ windowId: 8 }),
    });

    expect(baseline.status).toBe("baseline");
    expect(changedTarget.status).toBe("different-target");
    expect(shouldUseDiffOnly(baseline)).toBe(false);
    expect(shouldUseDiffOnly(changedTarget)).toBe(false);
  });

  it("preserves duplicate-line counts when computing changes", () => {
    const diff = computeStateDiff({
      previousLines: ["row", "row", "old"],
      currentLines: ["row", "new", "new"],
      previousTarget: target(),
      currentTarget: target({ capturedAt: "2026-07-09T00:00:01Z" }),
    });

    expect(diff.status).toBe("changed");
    expect(diff.removedLines).toEqual(["row", "old"]);
    expect(diff.addedLines).toEqual(["new", "new"]);
    expect(diff.changedLineCount).toBe(4);
    expect(shouldUseDiffOnly(diff)).toBe(true);
  });

  it("uses a compact unchanged response for identical state", () => {
    const diff = computeStateDiff({
      previousLines: ["window", "button"],
      currentLines: ["window", "button"],
      previousTarget: target(),
      currentTarget: target({ capturedAt: "2026-07-09T00:00:01Z" }),
    });

    expect(diff.status).toBe("unchanged");
    expect(shouldUseDiffOnly(diff)).toBe(true);
    expect(formatStateDiffBlock(diff)).toContain(
      "No accessibility-tree line changes",
    );
  });

  it("falls back to full state when a changed diff is truncated", () => {
    const diff = computeStateDiff({
      previousLines: ["old-1", "old-2", "old-3"],
      currentLines: ["new-1", "new-2", "new-3"],
      previousTarget: target(),
      currentTarget: target(),
      maxLines: 2,
    });

    expect(diff.truncated).toBe(true);
    expect(diff.addedLines).toHaveLength(1);
    expect(diff.removedLines).toHaveLength(1);
    expect(shouldUseDiffOnly(diff)).toBe(false);
    expect(formatStateDiffBlock(diff)).toContain("Diff truncated to 2 lines");
  });
});
