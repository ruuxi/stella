import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitGitMessage,
  listFilesForCommit,
  parseStellaCommitTrailers,
  revertGitFeature,
} from "../../../../../runtime/kernel/self-mod/git.js";

describe("parseStellaCommitTrailers — Stella-Thread", () => {
  it("parses Stella-Thread alongside Stella-Conversation", () => {
    const body = [
      "Tighten composer chip spacing",
      "",
      "Adjusts the gap between attached chips so they don't visually merge",
      "when more than two are present.",
      "",
      "Stella-Conversation: 7c1f2a40-aaaa-bbbb-cccc-1234abcd5678",
      "Stella-Thread: agent-thread-987",
    ].join("\n");

    const trailers = parseStellaCommitTrailers(body);

    expect(trailers.conversationId).toBe(
      "7c1f2a40-aaaa-bbbb-cccc-1234abcd5678",
    );
    expect(trailers.threadKey).toBe("agent-thread-987");
  });

  it("returns undefined threadKey when only the legacy trailer is present", () => {
    const body = [
      "Add foo",
      "",
      "Stella-Conversation: conv-1",
    ].join("\n");

    const trailers = parseStellaCommitTrailers(body);

    expect(trailers.conversationId).toBe("conv-1");
    expect(trailers.threadKey).toBeUndefined();
  });

  it("returns undefined threadKey when neither trailer is present", () => {
    const trailers = parseStellaCommitTrailers("Just a normal commit");
    expect(trailers.conversationId).toBeUndefined();
    expect(trailers.threadKey).toBeUndefined();
  });
});

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const initRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-revert-git-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repoRoot, "seed.txt"), "seed\n", "utf8");
  git(repoRoot, ["add", "seed.txt"]);
  git(repoRoot, ["commit", "-q", "-m", "Initial seed"]);
  return repoRoot;
};

describe("git revert end-to-end with Stella-Thread trailer", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await initRepo();
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("writes Stella-Thread + Stella-Conversation trailers and revertGitFeature reads them back", async () => {
    await writeFile(path.join(repoRoot, "feature.txt"), "v1\n", "utf8");
    git(repoRoot, ["add", "feature.txt"]);
    const commitHash = await commitGitMessage({
      repoRoot,
      subject: "Add feature.txt",
      trailers: {
        "Stella-Conversation": "conv-abc",
        "Stella-Thread": "thread-xyz",
      },
      paths: ["feature.txt"],
    });
    expect(commitHash).toBeTruthy();

    // Producer side: trailers actually landed in the commit body.
    const body = git(repoRoot, ["show", "-s", "--format=%B", commitHash!]);
    expect(body).toContain("Stella-Conversation: conv-abc");
    expect(body).toContain("Stella-Thread: thread-xyz");
    const parsed = parseStellaCommitTrailers(body);
    expect(parsed.conversationId).toBe("conv-abc");
    expect(parsed.threadKey).toBe("thread-xyz");

    // Round-trip: revert reads both trailers and returns them, sampled
    // from the original commit (not the synthetic "Revert ..." commit
    // git creates at HEAD).
    const revert = await revertGitFeature({
      repoRoot,
      featureId: commitHash!,
      steps: 1,
    });
    expect(revert.conversationId).toBe("conv-abc");
    expect(revert.originThreadKey).toBe("thread-xyz");
    expect(revert.files).toContain("feature.txt");
  });

  it("returns null originThreadKey when the commit has no Stella-Thread trailer (legacy)", async () => {
    await writeFile(path.join(repoRoot, "legacy.txt"), "v1\n", "utf8");
    git(repoRoot, ["add", "legacy.txt"]);
    const commitHash = await commitGitMessage({
      repoRoot,
      subject: "Add legacy.txt",
      trailers: {
        "Stella-Conversation": "conv-legacy",
        // intentionally no Stella-Thread (mimics pre-trailer commits)
      },
      paths: ["legacy.txt"],
    });
    expect(commitHash).toBeTruthy();

    const revert = await revertGitFeature({
      repoRoot,
      featureId: commitHash!,
      steps: 1,
    });
    expect(revert.conversationId).toBe("conv-legacy");
    expect(revert.originThreadKey).toBeNull();
  });
});

describe("listFilesForCommit", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await initRepo();
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns the files touched by a specific commit", async () => {
    await writeFile(path.join(repoRoot, "a.txt"), "a\n", "utf8");
    await mkdir(path.join(repoRoot, "nested"), { recursive: true });
    await writeFile(path.join(repoRoot, "nested/b.txt"), "b\n", "utf8");
    git(repoRoot, ["add", "a.txt", "nested/b.txt"]);
    const commitHash = await commitGitMessage({
      repoRoot,
      subject: "Add a + b",
      paths: ["a.txt", "nested/b.txt"],
    });

    const files = await listFilesForCommit(repoRoot, commitHash);
    expect(files.sort()).toEqual(["a.txt", "nested/b.txt"]);
  });

  it("returns an empty list when there is no self-mod commit history", async () => {
    // Fresh repo with only the seed commit (not a Stella self-mod commit) →
    // getLastGitFeatureId falls back to null, listFilesForCommit returns [].
    const files = await listFilesForCommit(repoRoot, null);
    expect(files).toEqual([]);
  });

  it("propagates a thrown error when given a non-existent commit hash", async () => {
    await expect(
      listFilesForCommit(repoRoot, "0000000000000000000000000000000000000000"),
    ).rejects.toThrow();
  });
});
