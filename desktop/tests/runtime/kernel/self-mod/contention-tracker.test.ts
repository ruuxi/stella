import { describe, expect, it } from "vitest";
import { createContentionTracker } from "../../../../../runtime/kernel/self-mod/contention-tracker.js";

const runIds = (runs: { runId: string }[]) => runs.map((r) => r.runId).sort();

describe("contention-tracker", () => {
  it("applies a single non-overlapping run on finalize", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.recordWrite("a", ["src/foo.tsx", "src/bar.tsx"]);
    const decision = tracker.finalize("a");
    expect(runIds(decision.applyBatch)).toEqual(["a"]);
    expect(tracker.hasRun("a")).toBe(false);
  });

  it("applies two non-overlapping concurrent runs independently", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/bar.tsx"]);

    const decisionA = tracker.finalize("a");
    expect(runIds(decisionA.applyBatch)).toEqual(["a"]);

    const decisionB = tracker.finalize("b");
    expect(runIds(decisionB.applyBatch)).toEqual(["b"]);
  });

  it("holds a run that overlaps with an active run, drains both as a batch on the second finalize", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx", "src/bar.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx", "src/baz.tsx"]);

    const decisionA = tracker.finalize("a");
    expect(decisionA.applyBatch).toEqual([]);
    expect(tracker.getRunStatus("a")).toBe("finalizedHeld");

    const decisionB = tracker.finalize("b");
    expect(runIds(decisionB.applyBatch)).toEqual(["a", "b"]);
    expect(tracker.hasRun("a")).toBe(false);
    expect(tracker.hasRun("b")).toBe(false);
  });

  it("does not deadlock when two finalized-held runs both touched the same path (only `active` owners block)", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.beginRun("c");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx"]);
    tracker.recordWrite("c", ["src/foo.tsx"]);

    expect(tracker.finalize("a").applyBatch).toEqual([]);
    expect(tracker.finalize("b").applyBatch).toEqual([]);
    const decision = tracker.finalize("c");
    expect(runIds(decision.applyBatch)).toEqual(["a", "b", "c"]);
  });

  it("drains overlapping runs in finalize order so newer snapshots apply last", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx"]);

    expect(tracker.finalize("b").applyBatch).toEqual([]);
    const decision = tracker.finalize("a");

    expect(decision.applyBatch.map((run) => run.runId)).toEqual(["b", "a"]);
  });

  it("extends the hold when a new active run touches a held path", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx"]);

    expect(tracker.finalize("a").applyBatch).toEqual([]);
    expect(tracker.getRunStatus("a")).toBe("finalizedHeld");

    tracker.beginRun("c");
    tracker.recordWrite("c", ["src/foo.tsx"]);

    const decisionB = tracker.finalize("b");
    expect(decisionB.applyBatch).toEqual([]);

    const decisionC = tracker.finalize("c");
    expect(runIds(decisionC.applyBatch)).toEqual(["a", "b", "c"]);
  });

  it("applies a non-overlapping run even when other runs are held on unrelated paths", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.beginRun("c");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx"]);
    tracker.recordWrite("c", ["src/baz.tsx"]);

    expect(tracker.finalize("a").applyBatch).toEqual([]);

    const decisionC = tracker.finalize("c");
    expect(runIds(decisionC.applyBatch)).toEqual(["c"]);
    expect(tracker.getRunStatus("a")).toBe("finalizedHeld");
  });

  it("releases held runs when the conflicting active run is cancelled", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx"]);

    expect(tracker.finalize("a").applyBatch).toEqual([]);

    const decision = tracker.cancel("b");
    expect(runIds(decision.applyBatch)).toEqual(["a"]);
    expect(tracker.hasRun("b")).toBe(false);
    expect(tracker.hasRun("a")).toBe(false);
  });

  it("cancel of a held run is a no-op for sibling held runs without active overlap", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/bar.tsx"]);
    expect(runIds(tracker.finalize("a").applyBatch)).toEqual(["a"]);

    tracker.beginRun("c");
    tracker.recordWrite("c", ["src/bar.tsx"]);
    expect(tracker.finalize("b").applyBatch).toEqual([]);

    const decision = tracker.cancel("c");
    expect(runIds(decision.applyBatch)).toEqual(["b"]);
  });

  it("ignores writes recorded after finalize", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.finalize("a");
    tracker.recordWrite("a", ["src/late.tsx"]);
    expect(tracker.getOwners("src/late.tsx")).toEqual([]);
  });

  it("finalize on an unknown run returns an empty batch", () => {
    const tracker = createContentionTracker();
    expect(tracker.finalize("unknown").applyBatch).toEqual([]);
  });

  it("finalize on a run with no touched paths releases it without applying", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    const decision = tracker.finalize("a");
    expect(decision.applyBatch).toEqual([]);
    expect(decision.releasedPaths).toEqual([]);
    expect(tracker.hasRun("a")).toBe(false);
  });

  it("dedupes duplicate path writes within a run", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.recordWrite("a", ["src/foo.tsx", "src/foo.tsx"]);
    tracker.recordWrite("a", ["src/foo.tsx"]);
    expect(tracker.getOwners("src/foo.tsx")).toEqual([
      { runId: "a", status: "active" },
    ]);
    const decision = tracker.finalize("a");
    expect(decision.applyBatch).toHaveLength(1);
    expect(Array.from(decision.applyBatch[0]!.touchedPaths)).toEqual([
      "src/foo.tsx",
    ]);
  });

  it("recordWrite reports newlyTrackedPaths only on first owner of each path", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    expect(
      tracker.recordWrite("a", ["src/foo.tsx", "src/bar.tsx"]).newlyTrackedPaths
        .sort(),
    ).toEqual(["src/bar.tsx", "src/foo.tsx"]);
    expect(
      tracker.recordWrite("a", ["src/foo.tsx"]).newlyTrackedPaths,
    ).toEqual([]);
    expect(
      tracker.recordWrite("b", ["src/foo.tsx", "src/baz.tsx"])
        .newlyTrackedPaths,
    ).toEqual(["src/baz.tsx"]);
  });

  it("cancel reports releasedPaths for paths whose last owner cancelled", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/only-a.tsx", "src/shared.tsx"]);
    tracker.recordWrite("b", ["src/shared.tsx"]);

    const decision = tracker.cancel("a");
    expect(decision.applyBatch).toEqual([]);
    expect(decision.releasedPaths).toEqual(["src/only-a.tsx"]);
  });

  it("finalize never reports releasedPaths (paths transferred via applyBatch)", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    const decision = tracker.finalize("a");
    expect(decision.releasedPaths).toEqual([]);
    expect(runIds(decision.applyBatch)).toEqual(["a"]);
  });

  it("getOwners reflects active vs finalizedHeld status transitions", () => {
    const tracker = createContentionTracker();
    tracker.beginRun("a");
    tracker.beginRun("b");
    tracker.recordWrite("a", ["src/foo.tsx"]);
    tracker.recordWrite("b", ["src/foo.tsx"]);
    expect(
      tracker
        .getOwners("src/foo.tsx")
        .sort((x, y) => x.runId.localeCompare(y.runId)),
    ).toEqual([
      { runId: "a", status: "active" },
      { runId: "b", status: "active" },
    ]);

    tracker.finalize("a");
    expect(
      tracker
        .getOwners("src/foo.tsx")
        .sort((x, y) => x.runId.localeCompare(y.runId)),
    ).toEqual([
      { runId: "a", status: "finalizedHeld" },
      { runId: "b", status: "active" },
    ]);
  });
});
