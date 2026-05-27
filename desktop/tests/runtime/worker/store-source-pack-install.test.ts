import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStellaSourcePack,
  createStellaSourceChangeSetFromTrees,
  createStellaSourcePack,
  hashSourceTree,
  type StellaSourceTree,
} from "../../../../runtime/kernel/self-mod/stella-source-control.js";
import {
  assertStoreSourcePackIntegrity,
  collectSourcePackPaths,
  findStoreSourcePackApplyObstruction,
  readLocalSourceTree,
  selectStoreSourcePackForInstalledRevisions,
  storeSourcePackTouchesDependencyFiles,
  storeSourcePathToAbsolute,
  writeSourcePackApplyResult,
} from "../../../../runtime/worker/store-source-pack-install.js";

const text = (content: string) => ({ kind: "text" as const, content });

describe("Store source-pack install helpers", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-source-install-"));
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("writes clean source-pack apply results into the repo", async () => {
    await writeFile(path.join(repoRoot, "src", "panel.ts"), "base\n", "utf8");
    await writeFile(
      path.join(repoRoot, "src", "remove.ts"),
      "remove me\n",
      "utf8",
    );
    const baseTree: StellaSourceTree = {
      "src/panel.ts": text("base\n"),
      "src/remove.ts": text("remove me\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/panel.ts": text("base\nfeature\n"),
      "src/new.ts": text("created\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId,
      baseTree,
      nextTree,
    });
    const pack = createStellaSourcePack({
      baseRevisionId,
      changeSets: [changeSet],
    });

    const paths = collectSourcePackPaths(pack);
    const localTree = await readLocalSourceTree(repoRoot, paths);
    const result = applyStellaSourcePack({ pack, localTree });
    expect(result.status).toBe("clean");

    await writeSourcePackApplyResult({
      repoRoot,
      paths,
      tree: result.tree,
      appliedPaths: result.appliedPaths,
    });

    await expect(
      readFile(path.join(repoRoot, "src", "panel.ts"), "utf8"),
    ).resolves.toBe("base\nfeature\n");
    await expect(
      readFile(path.join(repoRoot, "src", "new.ts"), "utf8"),
    ).resolves.toBe("created\n");
    await expect(
      readFile(path.join(repoRoot, "src", "remove.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects paths that escape the repo root", () => {
    expect(() => storeSourcePathToAbsolute(repoRoot, "../outside.ts")).toThrow(
      "Unsafe source-pack path",
    );
    expect(() =>
      storeSourcePathToAbsolute(repoRoot, "src/../inside.ts"),
    ).toThrow("Unsafe source-pack path");
    expect(() => storeSourcePathToAbsolute(repoRoot, "./inside.ts")).toThrow(
      "Unsafe source-pack path",
    );
    expect(() =>
      collectSourcePackPaths({
        kind: "stella-source-pack",
        schemaVersion: 1,
        baseRevisionId: "base",
        revisionId: "next",
        changeSets: [
          {
            schemaVersion: 1,
            baseRevisionId: "base",
            parentRevisionIds: ["base"],
            revisionId: "next",
            changes: [
              {
                path: "../outside.ts",
                baseHash: null,
                nextHash: null,
              },
            ],
          },
        ],
      }),
    ).toThrow("Unsafe source-pack path");
  });

  it("detects untracked files before direct source-pack apply", async () => {
    await writeFile(path.join(repoRoot, "src", "panel.ts"), "local\n", "utf8");

    await expect(
      findStoreSourcePackApplyObstruction({
        repoRoot,
        paths: ["src/panel.ts"],
        isPathTracked: async () => false,
      }),
    ).resolves.toMatchObject({
      path: "src/panel.ts",
      reason:
        "Source-pack path src/panel.ts is blocked by an untracked file.",
    });
  });

  it("detects symlink components before direct source-pack apply", async () => {
    await mkdir(path.join(repoRoot, "target"), { recursive: true });
    await symlink("target", path.join(repoRoot, "linked"), "dir");

    await expect(
      findStoreSourcePackApplyObstruction({
        repoRoot,
        paths: ["linked/panel.ts"],
        isPathTracked: async () => false,
      }),
    ).resolves.toMatchObject({
      path: "linked/panel.ts",
      reason: "Source-pack path linked/panel.ts crosses symlink linked.",
    });
  });

  it("verifies source-pack hashes and revision ids before direct apply", () => {
    const baseTree: StellaSourceTree = {
      "src/panel.ts": text("base\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/panel.ts": text("next\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const pack = createStellaSourcePack({
      baseRevisionId,
      changeSets: [
        createStellaSourceChangeSetFromTrees({
          baseRevisionId,
          baseTree,
          nextTree,
        }),
      ],
    });

    expect(assertStoreSourcePackIntegrity(pack)).toMatchObject({
      revisionId: pack.revisionId,
    });
    expect(() =>
      assertStoreSourcePackIntegrity({
        ...pack,
        changeSets: [
          {
            ...pack.changeSets[0]!,
            changes: [
              {
                ...pack.changeSets[0]!.changes[0]!,
                nextHash: "sha256:".concat("0".repeat(64)),
              },
            ],
          },
        ],
      }),
    ).toThrow("Source-pack incoming hash mismatch");
    expect(() =>
      assertStoreSourcePackIntegrity({
        ...pack,
        revisionId: "sha256:".concat("1".repeat(64)),
      }),
    ).toThrow("Source-pack final revision mismatch");
  });

  it("detects dependency file changes in Store source packs", () => {
    expect(
      storeSourcePackTouchesDependencyFiles(["src/panel.ts", "package.json"]),
    ).toBe(true);
    expect(storeSourcePackTouchesDependencyFiles(["src/panel.ts"])).toBe(false);
  });

  it("starts Store updates after the latest installed source revision", () => {
    const baseTree: StellaSourceTree = {
      "src/panel.ts": text("base\n"),
    };
    const v1Tree: StellaSourceTree = {
      "src/panel.ts": text("v1\n"),
    };
    const v2Tree: StellaSourceTree = {
      "src/panel.ts": text("v2\n"),
    };
    const baseRevisionId = hashSourceTree(baseTree);
    const v1 = createStellaSourceChangeSetFromTrees({
      baseRevisionId,
      baseTree,
      nextTree: v1Tree,
      featureId: "store:quiet-mode",
    });
    const v2 = createStellaSourceChangeSetFromTrees({
      baseRevisionId: v1.revisionId,
      parentRevisionIds: [v1.revisionId],
      baseTree: v1Tree,
      nextTree: v2Tree,
      featureId: "store:quiet-mode",
    });
    const pack = createStellaSourcePack({
      baseRevisionId,
      featureId: "store:quiet-mode",
      changeSets: [v1, v2],
    });

    const updatePlan = selectStoreSourcePackForInstalledRevisions(pack, [
      v1.revisionId,
    ]);
    expect(updatePlan.status).toBe("handoff");
    if (updatePlan.status !== "handoff") {
      throw new Error("Expected source pack update plan.");
    }
    expect(updatePlan.skippedRevisionIds).toEqual([v1.revisionId]);
    expect(updatePlan.sourcePack).toMatchObject({
      baseRevisionId: v1.revisionId,
      revisionId: v2.revisionId,
      changeSets: [expect.objectContaining({ revisionId: v2.revisionId })],
    });

    expect(
      selectStoreSourcePackForInstalledRevisions(pack, [v2.revisionId]),
    ).toEqual({
      status: "already-installed",
      revisionId: v2.revisionId,
    });
  });
});
