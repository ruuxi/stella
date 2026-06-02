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

describe("Stella source-pack desktop update simulation", () => {
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

  it("records a published release pointer after a local source-pack update commit", async () => {
    const installedCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    const targetCommit = "f".repeat(40);
    const manifestPath = path.join(repoRoot, "stella-install.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          version: "test",
          platform: "darwin-arm64",
          installPath: repoRoot,
          installedAt: new Date(0).toISOString(),
          desktopReleaseTag: "desktop-v0.0.1",
          desktopReleaseCommit: installedCommit,
          desktopInstallBaseCommit: installedCommit,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const baseTree: StellaSourceTree = {
      "src/copy.ts": text("one\ntwo\n"),
    };
    const authorTree: StellaSourceTree = {
      "src/copy.ts": text("one\ntwo\nthree\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree: authorTree,
    });
    const pack = createStellaSourcePack({
      baseRevisionId: hashSourceTree(baseTree),
      changeSets: [changeSet],
    });

    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "ONE\ntwo\n",
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
    git(repoRoot, ["commit", "-q", "-m", "Update to desktop-v0.0.2"]);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.desktopReleaseTag = "desktop-v0.0.2";
    manifest.desktopReleaseCommit = targetCommit;
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const ancestry = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", targetCommit, "HEAD"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(ancestry.status).not.toBe(0);
    expect(await readFile(path.join(repoRoot, "src", "copy.ts"), "utf8")).toBe(
      "ONE\ntwo\nthree\n",
    );
    expect(
      JSON.parse(await readFile(manifestPath, "utf8")).desktopReleaseCommit,
    ).toBe(targetCommit);
  });

  it("can write compatible source-pack paths before handing conflicts to the agent", async () => {
    await writeFile(path.join(repoRoot, "src/clean.ts"), "base clean\n", "utf8");
    await writeFile(
      path.join(repoRoot, "src/conflict.ts"),
      "title: base\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/clean.ts", "src/conflict.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Desktop v1 with two files"]);

    const baseTree: StellaSourceTree = {
      "src/clean.ts": text("base clean\n"),
      "src/conflict.ts": text("title: base\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/clean.ts": text("base clean\nnext clean\n"),
      "src/conflict.ts": text("title: upstream\n"),
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

    await writeFile(
      path.join(repoRoot, "src/conflict.ts"),
      "title: local\n",
      "utf8",
    );
    const sourcePaths = collectSourcePackPaths(pack);
    const localTree = await readLocalSourceTree(repoRoot, sourcePaths);
    const sourceApply = applyStellaSourcePack({ pack, localTree });

    expect(sourceApply).toMatchObject({
      status: "conflicts",
      appliedPaths: ["src/clean.ts"],
      conflicts: [expect.objectContaining({ path: "src/conflict.ts" })],
    });

    await writeSourcePackApplyResult({
      repoRoot,
      paths: sourcePaths,
      tree: sourceApply.tree,
      appliedPaths: sourceApply.appliedPaths,
    });

    await expect(
      readFile(path.join(repoRoot, "src/clean.ts"), "utf8"),
    ).resolves.toBe("base clean\nnext clean\n");
    await expect(
      readFile(path.join(repoRoot, "src/conflict.ts"), "utf8"),
    ).resolves.toBe("title: local\n");
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
