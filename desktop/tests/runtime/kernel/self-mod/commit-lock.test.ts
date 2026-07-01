/**
 * Cross-agent commit serialization: proves the per-repo commit lock and the
 * ref-lock retry keep concurrent agent commits from losing the HEAD-ref race
 * (`fatal: cannot lock ref 'HEAD': is at <sha> but expected <sha>`).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitGitMessage } from "../../../../../runtime/kernel/self-mod/git/commit.js";
import { withRepoCommitLock } from "../../../../../runtime/kernel/self-mod/git/commit-lock.js";
import { isRefLockContentionOutput } from "../../../../../runtime/kernel/self-mod/git/exec.js";
import { getGitHead } from "../../../../../runtime/kernel/self-mod/git/log.js";

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const repos: string[] = [];

const initRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-commit-lock-"));
  repos.push(repoRoot);
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repoRoot, "seed.txt"), "seed\n", "utf8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "Initial seed"]);
  return repoRoot;
};

afterEach(async () => {
  await Promise.all(
    repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

describe("isRefLockContentionOutput", () => {
  it("matches the reported HEAD ref-lock collision", () => {
    expect(
      isRefLockContentionOutput(
        "fatal: cannot lock ref 'HEAD': is at 1234abc but expected deadbee",
      ),
    ).toBe(true);
  });

  it("matches the sibling index.lock contention", () => {
    expect(
      isRefLockContentionOutput(
        "fatal: Unable to create '/repo/.git/index.lock': File exists.",
      ),
    ).toBe(true);
  });

  it("does not match ordinary git failures", () => {
    expect(
      isRefLockContentionOutput("error: pathspec 'nope' did not match"),
    ).toBe(false);
    expect(isRefLockContentionOutput("", "")).toBe(false);
  });
});

describe("withRepoCommitLock", () => {
  it("serializes same-repo callers so critical sections never overlap", async () => {
    const repo = await initRepo();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const task = (id: number) =>
      withRepoCommitLock(repo, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(id);
        // Yield across ticks to expose any overlap if serialization failed.
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([1, 2, 3, 4, 5].map((id) => task(id)));

    expect(maxActive).toBe(1);
    // FIFO: claims its slot in call order.
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("runs different repos concurrently", async () => {
    const [repoA, repoB] = await Promise.all([initRepo(), initRepo()]);
    let bothInside = false;
    let releaseA!: () => void;
    const aInside = new Promise<void>((resolve) => (releaseA = resolve));

    const a = withRepoCommitLock(repoA, async () => {
      releaseA();
      // Hold repoA until repoB confirms it can also enter.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const b = (async () => {
      await aInside;
      await withRepoCommitLock(repoB, async () => {
        bothInside = true;
      });
    })();

    await Promise.all([a, b]);
    expect(bothInside).toBe(true);
  });
});

describe("commitGitMessage under concurrency", () => {
  it("lands every concurrent path-scoped agent commit without a ref-lock abort", async () => {
    const repo = await initRepo();
    const fileCount = 12;
    await Promise.all(
      Array.from({ length: fileCount }, (_, i) =>
        writeFile(path.join(repo, `agent-${i}.txt`), `content ${i}\n`, "utf8"),
      ),
    );

    const results = await Promise.all(
      Array.from({ length: fileCount }, (_, i) =>
        commitGitMessage({
          repoRoot: repo,
          subject: `agent ${i} change`,
          paths: [`agent-${i}.txt`],
          trailers: { "Stella-Conversation": `conv-${i}` },
        }),
      ),
    );

    // Every commit produced a distinct hash — none aborted on the HEAD lock.
    const hashes = results.filter((hash): hash is string => Boolean(hash));
    expect(hashes).toHaveLength(fileCount);
    expect(new Set(hashes).size).toBe(fileCount);

    // Linear history: seed + one commit per agent, HEAD is one of ours, and
    // the top `fileCount` commits are exactly the returned hashes (no clobber,
    // no lost commits from a race).
    expect(Number(git(repo, ["rev-list", "--count", "HEAD"]))).toBe(
      fileCount + 1,
    );
    const head = await getGitHead(repo);
    expect(hashes).toContain(head);
    const topHashes = git(repo, [
      "rev-list",
      `--max-count=${fileCount}`,
      "HEAD",
    ])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(new Set(topHashes)).toEqual(new Set(hashes));
  });
});
