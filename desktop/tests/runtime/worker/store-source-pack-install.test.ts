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
  collectSourcePackPaths,
  findStoreSourcePackApplyObstruction,
  readLocalSourceTree,
  storePublishTouchesDependencyFiles,
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

  it("detects dependency file changes in publish/import paths", () => {
    expect(
      storePublishTouchesDependencyFiles(["src/panel.ts", "package.json"]),
    ).toBe(true);
    expect(storePublishTouchesDependencyFiles(["src/panel.ts"])).toBe(false);
  });
});
