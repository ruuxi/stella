import { describe, expect, it } from "vitest";
import {
  applyStellaSourcePack,
  applyStellaSourceChangeSetSequence,
  applyStellaSourceChangeSet,
  createStellaSourcePack,
  createStellaSourceChangeSet,
  createStellaSourceChangeSetFromTrees,
  hashSourceBlob,
  hashSourceTree,
  mergeTextContent,
  stripStellaSourceChangeSetContent,
  type StellaSourceTree,
} from "../../../../../runtime/kernel/self-mod/stella-source-control.js";

const text = (content: string) => ({ kind: "text" as const, content });

describe("Stella source control change sets", () => {
  it("records only changed paths while preserving stable base-history identity", () => {
    const baseTree: StellaSourceTree = {
      "app.tsx": text("export const title = 'Before';\n"),
      "unchanged.ts": text("same\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const nextTree: StellaSourceTree = {
      "app.tsx": text("export const title = 'After';\n"),
      "unchanged.ts": text("same\n"),
      "feature.ts": text("export const enabled = true;\n"),
    };

    const first = createStellaSourceChangeSetFromTrees({
      baseRevisionId,
      baseTree,
      nextTree,
      featureId: "feature:welcome-copy",
      description: "Welcome copy",
    });
    const second = createStellaSourceChangeSet({
      baseRevisionId,
      parentRevisionIds: [baseRevisionId],
      featureId: "feature:welcome-copy",
      description: "Welcome copy",
      changes: first.changes.map((change) => ({
        path: change.path,
        baseHash: change.baseHash,
        nextHash: change.nextHash,
        // Omit content to model the history-only identity Stella can seed in
        // every install without cloning the author's full source tree.
      })),
    });

    expect(first.changes.map((change) => change.path)).toEqual([
      "app.tsx",
      "feature.ts",
    ]);
    expect(first.revisionId).toBe(second.revisionId);
    expect(first.changes[0]?.base).toEqual(baseTree["app.tsx"]);
    expect(first.changes.find((change) => change.path === "unchanged.ts")).toBe(
      undefined,
    );
  });

  it("strips source content from persisted history without changing revision identity", () => {
    const baseTree: StellaSourceTree = {
      "app.tsx": text("before\n"),
    };
    const nextTree: StellaSourceTree = {
      "app.tsx": text("after\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree,
      featureId: "feature:history",
    });

    const stripped = stripStellaSourceChangeSetContent(changeSet);

    expect(stripped.revisionId).toBe(changeSet.revisionId);
    expect(stripped.changes[0]).not.toHaveProperty("base");
    expect(stripped.changes[0]).not.toHaveProperty("next");
  });

  it("applies clean source packs when the local file still matches the shared base", () => {
    const baseTree: StellaSourceTree = {
      "app.tsx": text("export const title = 'Before';\n"),
    };
    const nextTree: StellaSourceTree = {
      "app.tsx": text("export const title = 'After';\n"),
      "feature.ts": text("export const enabled = true;\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId,
      baseTree,
      nextTree,
    });

    const result = applyStellaSourceChangeSet({
      baseTree,
      localTree: baseTree,
      changeSet,
    });

    expect(result.status).toBe("clean");
    expect(result.appliedPaths).toEqual(["app.tsx", "feature.ts"]);
    expect(result.tree).toEqual(nextTree);
  });

  it("returns noops for packs already present in the user's tree", () => {
    const baseTree: StellaSourceTree = {
      "app.tsx": text("before\n"),
    };
    const nextTree: StellaSourceTree = {
      "app.tsx": text("after\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree,
    });

    const result = applyStellaSourceChangeSet({
      baseTree,
      localTree: nextTree,
      changeSet,
    });

    expect(result.status).toBe("clean");
    expect(result.appliedPaths).toEqual([]);
    expect(result.noopPaths).toEqual(["app.tsx"]);
    expect(result.tree).toEqual(nextTree);
  });

  it("applies grouped feature revisions in order for Store install and update chains", () => {
    const baseTree: StellaSourceTree = {
      "feature.ts": text("export const label = 'Base';\n"),
    };
    const v1Tree: StellaSourceTree = {
      "feature.ts": text("export const label = 'V1';\n"),
    };
    const v2Tree: StellaSourceTree = {
      "feature.ts": text("export const label = 'V2';\n"),
      "feature-settings.ts": text("export const enabled = true;\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const v1 = createStellaSourceChangeSetFromTrees({
      baseRevisionId,
      baseTree,
      nextTree: v1Tree,
      featureId: "feature:chain",
    });
    const v2 = createStellaSourceChangeSetFromTrees({
      baseRevisionId: v1.revisionId,
      parentRevisionIds: [v1.revisionId],
      baseTree: v1Tree,
      nextTree: v2Tree,
      featureId: "feature:chain",
    });

    const result = applyStellaSourceChangeSetSequence({
      baseTree,
      localTree: baseTree,
      changeSets: [v1, v2],
    });

    expect(result.status).toBe("clean");
    expect(result.revisionId).toBe(v2.revisionId);
    expect(result.appliedPaths).toEqual([
      "feature.ts",
      "feature-settings.ts",
      "feature.ts",
    ]);
    expect(result.tree).toEqual(v2Tree);
  });

  it("reconstructs the original pack base when a feature adds then edits a file", () => {
    const baseTree: StellaSourceTree = {};
    const v1Tree: StellaSourceTree = {
      "new-panel.tsx": text("export const title = 'First';\n"),
    };
    const v2Tree: StellaSourceTree = {
      "new-panel.tsx": text("export const title = 'Second';\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const v1 = createStellaSourceChangeSetFromTrees({
      baseRevisionId,
      baseTree,
      nextTree: v1Tree,
      featureId: "feature:new-panel",
    });
    const v2 = createStellaSourceChangeSetFromTrees({
      baseRevisionId: v1.revisionId,
      parentRevisionIds: [v1.revisionId],
      baseTree: v1Tree,
      nextTree: v2Tree,
      featureId: "feature:new-panel",
    });
    const pack = createStellaSourcePack({
      baseRevisionId,
      featureId: "feature:new-panel",
      changeSets: [v1, v2],
    });

    const result = applyStellaSourcePack({
      pack,
      localTree: {},
    });

    expect(result.status).toBe("clean");
    expect(result.tree).toEqual(v2Tree);
  });

  it("applies a Store source pack from touched-path base content", () => {
    const baseTree: StellaSourceTree = {
      "feature.ts": text("one\ntwo\nthree\n"),
      "untouched.ts": text("kept out of the pack\n"),
    };
    const nextTree: StellaSourceTree = {
      ...baseTree,
      "feature.ts": text("one\ntwo\nTHREE\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree,
      featureId: "feature:pack",
    });
    const pack = createStellaSourcePack({
      baseRevisionId: hashSourceTree(baseTree),
      featureId: "feature:pack",
      changeSets: [changeSet],
    });

    const result = applyStellaSourcePack({
      pack,
      localTree: {
        "feature.ts": text("ONE\ntwo\nthree\n"),
      },
    });

    expect(result.status).toBe("clean");
    expect(result.tree).toEqual({
      "feature.ts": text("ONE\ntwo\nTHREE\n"),
    });
    expect(JSON.stringify(pack)).not.toContain("kept out of the pack");
  });
});

describe("Stella source control three-way text merge", () => {
  it("merges non-overlapping local and incoming edits without an agent", () => {
    const base = "one\ntwo\nthree\n";
    const local = "ONE\ntwo\nthree\n";
    const incoming = "one\ntwo\nTHREE\n";

    const result = mergeTextContent(base, local, incoming);

    expect(result).toEqual({
      status: "clean",
      content: "ONE\ntwo\nTHREE\n",
    });
  });

  it("surfaces overlapping edits as conflicts for an agent to resolve", () => {
    const baseTree: StellaSourceTree = {
      "copy.ts": text("export const label = 'Start';\n"),
    };
    const authorTree: StellaSourceTree = {
      "copy.ts": text("export const label = 'Author';\n"),
    };
    const localTree: StellaSourceTree = {
      "copy.ts": text("export const label = 'Mine';\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree: authorTree,
    });

    const result = applyStellaSourceChangeSet({
      baseTree,
      localTree,
      changeSet,
    });

    expect(result.status).toBe("conflicts");
    expect(result.tree).toEqual(localTree);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "copy.ts",
      reason: "text-conflict",
      baseHash: hashSourceBlob(baseTree["copy.ts"]),
      localHash: hashSourceBlob(localTree["copy.ts"]),
      incomingHash: hashSourceBlob(authorTree["copy.ts"]),
    });
  });

  it("keeps user deletions as conflicts when incoming changes still target that file", () => {
    const baseTree: StellaSourceTree = {
      "panel.tsx": text("export const panel = true;\n"),
    };
    const authorTree: StellaSourceTree = {
      "panel.tsx": text("export const panel = 'updated';\n"),
    };
    const localTree: StellaSourceTree = {};
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree: authorTree,
    });

    const result = applyStellaSourceChangeSet({
      baseTree,
      localTree,
      changeSet,
    });

    expect(result.status).toBe("conflicts");
    expect(result.tree).toEqual(localTree);
    expect(result.conflicts[0]).toMatchObject({
      path: "panel.tsx",
      reason: "binary-or-delete-conflict",
    });
  });
});
