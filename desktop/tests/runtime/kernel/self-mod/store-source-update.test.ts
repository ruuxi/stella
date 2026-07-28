import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStellaSourcePack,
  createStellaSourceChangeSetFromTrees,
  createStellaSourcePack,
  hashSourceTree,
  type StellaSourceTree,
} from "../../../../../runtime/kernel/self-mod/stella-source-control.js";
import {
  collectSourcePackPaths,
  readLocalSourceTree,
  writeSourcePackApplyResult,
} from "../../../../../runtime/worker/store-source-pack-install.js";

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const text = (content: string) => ({ kind: "text" as const, content });

describe("Stella Store source-pack update simulation", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-source-update-"));
    git(repoRoot, ["init", "-q", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "test@stella.local"]);
    git(repoRoot, ["config", "user.name", "Stella Test"]);
    git(repoRoot, ["config", "commit.gpgsign", "false"]);
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "one\ntwo\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "Initial desktop release"]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("applies a Store feature update cleanly after non-overlapping local divergence", async () => {
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "title: v1\nbody: unchanged\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "Install Quiet Mode v1"]);

    const v1Tree: StellaSourceTree = {
      "src/copy.ts": text("title: v1\nbody: unchanged\n"),
    };
    const v2Tree: StellaSourceTree = {
      "src/copy.ts": text("title: v1\nbody: v2\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(v1Tree),
      baseTree: v1Tree,
      nextTree: v2Tree,
      featureId: "store:quiet-mode",
      description: "Quiet Mode v2",
    });
    const pack = createStellaSourcePack({
      baseRevisionId: hashSourceTree(v1Tree),
      featureId: "store:quiet-mode",
      description: "Quiet Mode v2",
      changeSets: [changeSet],
    });

    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "title: local custom\nbody: unchanged\n",
      "utf8",
    );
    const sourcePaths = collectSourcePackPaths(pack);
    const localTree = await readLocalSourceTree(repoRoot, sourcePaths);
    const sourceApply = applyStellaSourcePack({ pack, localTree });

    expect(sourceApply.status).toBe("clean");
    await writeSourcePackApplyResult({
      repoRoot,
      paths: sourcePaths,
      tree: sourceApply.tree,
      appliedPaths: sourceApply.appliedPaths,
    });
    git(repoRoot, ["add", "-A", "--", ...sourceApply.appliedPaths]);
    git(repoRoot, ["commit", "-q", "-m", "Update Quiet Mode to v2"]);

    expect(await readFile(path.join(repoRoot, "src", "copy.ts"), "utf8")).toBe(
      "title: local custom\nbody: v2\n",
    );
    expect(git(repoRoot, ["log", "--format=%s", "-2"])).toBe(
      "Update Quiet Mode to v2\nInstall Quiet Mode v1",
    );
  });

  it("writes Store feature update conflicts for agent resolution when edits overlap", async () => {
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "title: v1\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "Install Quiet Mode v1"]);

    const v1Tree: StellaSourceTree = {
      "src/copy.ts": text("title: v1\n"),
    };
    const v2Tree: StellaSourceTree = {
      "src/copy.ts": text("title: author v2\n"),
    };
    const pack = createStellaSourcePack({
      baseRevisionId: hashSourceTree(v1Tree),
      featureId: "store:quiet-mode",
      description: "Quiet Mode v2",
      changeSets: [
        createStellaSourceChangeSetFromTrees({
          baseRevisionId: hashSourceTree(v1Tree),
          baseTree: v1Tree,
          nextTree: v2Tree,
          featureId: "store:quiet-mode",
          description: "Quiet Mode v2",
        }),
      ],
    });

    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "title: local custom\n",
      "utf8",
    );
    const sourcePaths = collectSourcePackPaths(pack);
    const localTree = await readLocalSourceTree(repoRoot, sourcePaths);
    const sourceApply = applyStellaSourcePack({ pack, localTree });
    expect(sourceApply.status).toBe("conflicts");

    const conflictPath = path.join(
      repoRoot,
      "state",
      "raw",
      "store-installs",
      "quiet-mode-r2",
      "SOURCE_PACK_CONFLICTS.json",
    );
    await mkdir(path.dirname(conflictPath), { recursive: true });
    await writeFile(
      conflictPath,
      `${JSON.stringify(
        {
          status: sourceApply.status,
          revisionId: sourceApply.revisionId,
          conflicts: sourceApply.conflicts,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const conflictJson = await readFile(conflictPath, "utf8");
    expect(conflictJson).toContain('"reason": "text-conflict"');
    expect(conflictJson).toContain("title: local custom");
    expect(conflictJson).toContain("title: author v2");
    expect(await readFile(path.join(repoRoot, "src", "copy.ts"), "utf8")).toBe(
      "title: local custom\n",
    );
  });
});
