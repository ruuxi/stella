import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStellaSourcePack } from "../../../../runtime/kernel/self-mod/stella-source-control.js";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../../scripts/generate-desktop-source-pack.mjs",
);

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const text = (content: string) => ({ kind: "text" as const, content });

describe("generate-desktop-source-pack", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "desktop-source-pack-"));
    git(repoRoot, ["init", "-q", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "test@stella.local"]);
    git(repoRoot, ["config", "user.name", "Stella Test"]);
    git(repoRoot, ["config", "commit.gpgsign", "false"]);
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "feature.ts"),
      "one\ntwo\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "desktop v1"]);
    git(repoRoot, ["tag", "desktop-v0.0.1"]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("generates an official desktop source pack from the previous desktop tag", async () => {
    await writeFile(
      path.join(repoRoot, "src", "feature.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "src", "settings.ts"),
      "export const enabled = true;\n",
      "utf8",
    );
    await mkdir(path.join(repoRoot, "desktop", "native", "out", "darwin"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "desktop", "native", "out", "darwin", "helper"),
      "binary-ish helper payload\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "desktop v2"]);
    git(repoRoot, ["tag", "desktop-v0.0.2"]);

    const outputPath = path.join(repoRoot, "out", "source-pack.json");
    const historyOutputPath = path.join(repoRoot, "out", "source-history.json");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--tag",
        "desktop-v0.0.2",
        "--target",
        "desktop-v0.0.2",
        "--output",
        outputPath,
        "--history-output",
        historyOutputPath,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const pack = JSON.parse(await readFile(outputPath, "utf8"));
    const history = JSON.parse(await readFile(historyOutputPath, "utf8"));
    expect(JSON.stringify(pack)).not.toContain("binary-ish helper payload");
    expect(
      pack.changeSets[0].changes.map((change: { path: string }) => change.path),
    ).toEqual(["src/feature.ts", "src/settings.ts"]);
    expect(history.revisionId).toBe(pack.revisionId);
    expect(history.changeSets[0].revisionId).toBe(
      pack.changeSets[0].revisionId,
    );
    expect(JSON.stringify(history)).not.toContain("one\\ntwo");
    expect(JSON.stringify(history)).not.toContain("three");
    expect(
      history.changeSets[0].changes.every(
        (change: { base?: unknown; next?: unknown }) =>
          !("base" in change) && !("next" in change),
      ),
    ).toBe(true);
    expect(history.changeSets[0].changes).toEqual(
      pack.changeSets[0].changes.map(
        (change: {
          path: string;
          baseHash: string | null;
          nextHash: string | null;
        }) => ({
          path: change.path,
          baseHash: change.baseHash,
          nextHash: change.nextHash,
        }),
      ),
    );

    const apply = applyStellaSourcePack({
      pack,
      localTree: {
        "src/feature.ts": text("ONE\ntwo\n"),
      },
    });

    expect(apply.status).toBe("clean");
    expect(apply.tree).toEqual({
      "src/feature.ts": text("ONE\ntwo\nthree\n"),
      "src/settings.ts": text("export const enabled = true;\n"),
    });
  });

  it("records the peeled commit for an annotated base tag", async () => {
    git(repoRoot, ["tag", "-d", "desktop-v0.0.1"]);
    git(repoRoot, [
      "tag",
      "-a",
      "desktop-v0.0.1",
      "-m",
      "annotated desktop v1",
    ]);
    const baseTagObject = git(repoRoot, ["rev-parse", "desktop-v0.0.1"]);
    const baseCommit = git(repoRoot, [
      "rev-parse",
      "desktop-v0.0.1^{commit}",
    ]);
    expect(baseTagObject).not.toBe(baseCommit);

    await writeFile(
      path.join(repoRoot, "src", "feature.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "desktop v2"]);
    git(repoRoot, [
      "tag",
      "-a",
      "desktop-v0.0.2",
      "-m",
      "annotated desktop v2",
    ]);

    const outputPath = path.join(repoRoot, "out", "source-pack.json");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--tag",
        "desktop-v0.0.2",
        "--target",
        "desktop-v0.0.2",
        "--base",
        "desktop-v0.0.1",
        "--output",
        outputPath,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const pack = JSON.parse(await readFile(outputPath, "utf8"));
    expect(pack.baseRevisionId).toBe(`git:${baseCommit}`);
    expect(pack.baseRevisionId).not.toBe(`git:${baseTagObject}`);
    expect(pack.changeSets[0].baseRevisionId).toBe(`git:${baseCommit}`);
    expect(pack.changeSets[0].parentRevisionIds).toEqual([
      `git:${baseCommit}`,
    ]);
  });

  it("still writes history when the content pack is above the release limit", async () => {
    await writeFile(
      path.join(repoRoot, "src", "feature.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "desktop v2"]);
    git(repoRoot, ["tag", "desktop-v0.0.2"]);

    const outputPath = path.join(repoRoot, "out", "source-pack.json");
    const historyOutputPath = path.join(repoRoot, "out", "source-history.json");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--tag",
        "desktop-v0.0.2",
        "--target",
        "desktop-v0.0.2",
        "--output",
        outputPath,
        "--history-output",
        historyOutputPath,
        "--max-bytes",
        "1",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("source pack skipped");
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
    const history = JSON.parse(await readFile(historyOutputPath, "utf8"));
    expect(history.changeSets[0].changes).toEqual([
      {
        path: "src/feature.ts",
        baseHash: expect.any(String),
        nextHash: expect.any(String),
      },
    ]);
    expect(JSON.stringify(history)).not.toContain("three");
  });

  it("keeps large changed paths as hash-only entries instead of dropping them", async () => {
    await writeFile(
      path.join(repoRoot, "src", "large.txt"),
      `${"x".repeat(760_000)}\n`,
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "desktop v2"]);
    git(repoRoot, ["tag", "desktop-v0.0.2"]);

    const outputPath = path.join(repoRoot, "out", "source-pack.json");
    const historyOutputPath = path.join(repoRoot, "out", "source-history.json");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--tag",
        "desktop-v0.0.2",
        "--target",
        "desktop-v0.0.2",
        "--output",
        outputPath,
        "--history-output",
        historyOutputPath,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const pack = JSON.parse(await readFile(outputPath, "utf8"));
    const history = JSON.parse(await readFile(historyOutputPath, "utf8"));
    const largeChange = pack.changeSets[0].changes.find(
      (change: { path: string }) => change.path === "src/large.txt",
    );

    expect(largeChange).toMatchObject({
      path: "src/large.txt",
      baseHash: null,
      nextHash: expect.stringMatching(/^git-blob:/),
    });
    expect(largeChange).not.toHaveProperty("next");
    expect(history.changeSets[0].changes).toContainEqual({
      path: "src/large.txt",
      baseHash: null,
      nextHash: largeChange.nextHash,
    });
    expect(JSON.stringify(history)).not.toContain("xxxx");

    const apply = applyStellaSourcePack({
      pack,
      localTree: {},
    });
    expect(apply.status).toBe("conflicts");
    expect(apply.conflicts[0]).toMatchObject({
      path: "src/large.txt",
      reason: "missing-incoming-content",
    });
  });
});
