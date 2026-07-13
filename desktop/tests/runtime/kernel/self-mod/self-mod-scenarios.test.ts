/**
 * End-to-end self-mod scenarios against REAL temp git repositories:
 * agent finalize on clean/messy trees, concurrent-run commit attribution,
 * undo (revert), store uninstall (direct revert, fallbacks, atomicity),
 * trailer validation, deferred source-history + namer, batched log reads,
 * and chronological ordering.
 */
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { StellaSourceHistoryStore } from "../../../../../runtime/kernel/storage/stella-source-history-store.js";
import { StoreModStore } from "../../../../../runtime/kernel/storage/store-mod-store.js";
import { StoreModService } from "../../../../../runtime/kernel/self-mod/store-mod-service.js";
import { createSelfModHmrController } from "../../../../../runtime/kernel/self-mod/hmr.js";
import {
  detectSelfModAppliedSince,
  getGitHead,
  listGitDirtyFiles,
  listRecentGitCommits,
  listRecentSelfModCommits,
  orderCommitHashesChronologically,
} from "../../../../../runtime/kernel/self-mod/git/log.js";
import {
  revertGitCommits,
  revertSelfModCommit,
} from "../../../../../runtime/kernel/self-mod/git/revert.js";
import { readGitObjectsBatch } from "../../../../../runtime/kernel/self-mod/git/snapshots.js";
import { parseStellaCommitTrailers } from "../../../../../runtime/kernel/self-mod/git/trailers.js";

const git = (cwd: string, args: string[], env?: Record<string, string>) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

type Harness = {
  repoRoot: string;
  dbRoot: string;
  db: SqliteDatabase;
  store: StoreModStore;
  sourceHistory: StellaSourceHistoryStore;
  service: StoreModService;
};

const harnesses = new Set<Harness>();

const createHarness = async (): Promise<Harness> => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-scenario-"));
  const dbRoot = await mkdtemp(path.join(os.tmpdir(), "stella-scenario-db-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "desktop", "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "desktop", "src", "seed.tsx"),
    "export const seed = 1;\n",
    "utf8",
  );
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "Initial seed"]);

  const db = new DatabaseSync(getDesktopDatabasePath(dbRoot), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new StoreModStore(db);
  const sourceHistory = new StellaSourceHistoryStore(db);
  const service = new StoreModService(repoRoot, store, sourceHistory);
  const harness = { repoRoot, dbRoot, db, store, sourceHistory, service };
  harnesses.add(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses) {
    harness.db.close();
    await rm(harness.repoRoot, { recursive: true, force: true });
    await rm(harness.dbRoot, { recursive: true, force: true });
  }
  harnesses.clear();
});

const writeRepoFile = async (
  repoRoot: string,
  relPath: string,
  content: string,
) => {
  await mkdir(path.dirname(path.join(repoRoot, relPath)), { recursive: true });
  await writeFile(path.join(repoRoot, relPath), content, "utf8");
};

const waitForPath = async (filePath: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await readFile(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

const commitBody = (repoRoot: string, hash: string): string =>
  git(repoRoot, ["show", "-s", "--format=%B", hash]);

const commitFiles = (repoRoot: string, hash: string): string[] =>
  git(repoRoot, ["show", "--name-only", "--pretty=format:", hash])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();

describe("agent finalize", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("clean tree: commits exactly the run's files with trailers and agent-authored subject", async () => {
    await h.service.beginSelfModRun({
      runId: "run-1",
      taskDescription: "Add widget panel",
    });
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/panel.tsx",
      "export const panel = true;\n",
    );
    let providerArgs: { files: string[] } | null = null;
    const finalized = await h.service.finalizeSelfModRun({
      runId: "run-1",
      succeeded: true,
      conversationId: "conv-1",
      threadKey: "thread-1",
      commitMessageProvider: async ({ files }) => {
        providerArgs = { files };
        return "Add a panel to the home screen";
      },
    });
    expect(providerArgs).toEqual({ files: ["desktop/src/panel.tsx"] });

    expect(finalized?.files).toEqual(["desktop/src/panel.tsx"]);
    expect(finalized?.blockedFiles).toEqual([]);
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);

    const body = commitBody(h.repoRoot, finalized!.commitHash);
    expect(body).toContain("Add a panel to the home screen");
    const trailers = parseStellaCommitTrailers(body);
    expect(trailers.conversationId).toBe("conv-1");
    expect(trailers.threadKey).toBe("thread-1");
    expect(commitFiles(h.repoRoot, finalized!.commitHash)).toEqual([
      "desktop/src/panel.tsx",
    ]);
  });

  it("messy tree: pre-existing user changes are blocked and survive the commit untouched", async () => {
    // User has uncommitted work BEFORE the agent run starts.
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/seed.tsx",
      "export const seed = 999; // user WIP\n",
    );
    await writeRepoFile(h.repoRoot, "notes.txt", "user scratch notes\n");

    await h.service.beginSelfModRun({
      runId: "run-messy",
      taskDescription: "Agent change on messy tree",
    });
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/agent.tsx",
      "export const agent = 1;\n",
    );
    const finalized = await h.service.finalizeSelfModRun({
      runId: "run-messy",
      succeeded: true,
      conversationId: "conv-messy",
    });

    expect(finalized?.files).toEqual(["desktop/src/agent.tsx"]);
    expect(finalized?.blockedFiles.sort()).toEqual(
      ["desktop/src/seed.tsx", "notes.txt"].sort(),
    );
    expect(commitFiles(h.repoRoot, finalized!.commitHash)).toEqual([
      "desktop/src/agent.tsx",
    ]);
    // User WIP is still dirty, byte-for-byte intact.
    expect((await listGitDirtyFiles(h.repoRoot)).sort()).toEqual(
      ["desktop/src/seed.tsx", "notes.txt"].sort(),
    );
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/seed.tsx"), "utf8"),
    ).toContain("user WIP");
  });

  it("concurrent runs: a finalizing run never sweeps a still-active run's files into its commit", async () => {
    const controller = createSelfModHmrController({
      getDevServerUrl: () => "http://127.0.0.1:1",
      enabled: false,
      repoRoot: h.repoRoot,
    });
    await controller.beginRun("run-a");
    await controller.beginRun("run-b");
    await h.service.beginSelfModRun({
      runId: "run-a",
      taskDescription: "Run A",
    });
    await h.service.beginSelfModRun({
      runId: "run-b",
      taskDescription: "Run B",
    });

    await writeRepoFile(
      h.repoRoot,
      "desktop/src/a.tsx",
      "export const a = 1;\n",
    );
    await controller.recordWrite("run-a", [
      path.join(h.repoRoot, "desktop/src/a.tsx"),
    ]);
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/b.tsx",
      "export const b = 1;\n",
    );
    await controller.recordWrite("run-b", [
      path.join(h.repoRoot, "desktop/src/b.tsx"),
    ]);

    // A finishes first while B is still running.
    const finalizedA = await h.service.finalizeSelfModRun({
      runId: "run-a",
      succeeded: true,
      conversationId: "conv-a",
      threadKey: "thread-a",
      isPathOwnedByAnotherActiveRun: (p) =>
        controller.isPathOwnedByAnotherActiveRun(p, "run-a"),
    });
    controller.finalize("run-a");

    expect(finalizedA?.files).toEqual(["desktop/src/a.tsx"]);
    expect(finalizedA?.blockedFiles).toEqual(["desktop/src/b.tsx"]);
    expect(commitFiles(h.repoRoot, finalizedA!.commitHash)).toEqual([
      "desktop/src/a.tsx",
    ]);
    expect(
      parseStellaCommitTrailers(commitBody(h.repoRoot, finalizedA!.commitHash))
        .conversationId,
    ).toBe("conv-a");
    // B's file is still dirty, waiting for B's own finalize.
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual(["desktop/src/b.tsx"]);

    // B finishes later and commits its own file under its own conversation.
    const finalizedB = await h.service.finalizeSelfModRun({
      runId: "run-b",
      succeeded: true,
      conversationId: "conv-b",
      threadKey: "thread-b",
      isPathOwnedByAnotherActiveRun: (p) =>
        controller.isPathOwnedByAnotherActiveRun(p, "run-b"),
    });
    controller.finalize("run-b");

    expect(finalizedB?.files).toEqual(["desktop/src/b.tsx"]);
    expect(commitFiles(h.repoRoot, finalizedB!.commitHash)).toEqual([
      "desktop/src/b.tsx",
    ]);
    expect(
      parseStellaCommitTrailers(commitBody(h.repoRoot, finalizedB!.commitHash))
        .conversationId,
    ).toBe("conv-b");
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);
  });

  it("cancelled run commits nothing and leaves its writes dirty", async () => {
    await h.service.beginSelfModRun({
      runId: "run-cancel",
      taskDescription: "Doomed run",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/tmp.tsx", "export {};\n");
    const before = await getGitHead(h.repoRoot);

    h.service.cancelSelfModRun("run-cancel");
    const finalized = await h.service.finalizeSelfModRun({
      runId: "run-cancel",
      succeeded: true,
      conversationId: "conv-x",
    });

    expect(finalized).toBeNull();
    expect(await getGitHead(h.repoRoot)).toBe(before);
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([
      "desktop/src/tmp.tsx",
    ]);
  });

  it("revokes a finalizer held inside a pre-commit hook and hands its dirty paths to the replacement", async () => {
    const file = "desktop/src/seed.tsx";
    const before = await getGitHead(h.repoRoot);
    const hookPath = path.join(h.repoRoot, ".git/hooks/pre-commit");
    const hookStarted = path.join(h.repoRoot, ".git/hook-started");
    const hookRelease = path.join(h.repoRoot, ".git/hook-release");
    await writeFile(
      hookPath,
      `#!/bin/sh\ntouch .git/hook-started\nwhile [ ! -f .git/hook-release ]; do sleep 0.02; done\n`,
      "utf8",
    );
    await chmod(hookPath, 0o755);
    await h.service.beginSelfModRun({
      runId: "old-run",
      ownershipKey: "thread-owner",
      taskDescription: "Old attempt",
    });
    await writeRepoFile(h.repoRoot, file, "export const owner = 'old';\n");

    const oldFinalize = h.service.finalizeSelfModRun({
      runId: "old-run",
      succeeded: true,
      conversationId: "old-conversation",
      threadKey: "old-thread",
      commitMessageProvider: async () => "Commit old attempt",
    });
    await waitForPath(hookStarted);

    h.service.cancelSelfModRun("old-run");
    await h.service.beginSelfModRun({
      runId: "replacement-run",
      ownershipKey: "thread-owner",
      taskDescription: "Replacement attempt",
    });
    await writeRepoFile(
      h.repoRoot,
      file,
      "export const owner = 'replacement';\n",
    );

    await writeFile(hookRelease, "release\n", "utf8");
    expect(await oldFinalize).toBeNull();
    expect(await getGitHead(h.repoRoot)).toBe(before);
    await rm(hookPath, { force: true });

    const replacement = await h.service.finalizeSelfModRun({
      runId: "replacement-run",
      succeeded: true,
      conversationId: "replacement-conversation",
      threadKey: "replacement-thread",
      commitMessageProvider: async () => "Commit replacement attempt",
    });
    expect(replacement?.files).toEqual([file]);
    expect(await getGitHead(h.repoRoot)).toBe(replacement?.commitHash);
    expect(
      git(h.repoRoot, ["show", `${replacement!.commitHash}:${file}`]),
    ).toBe("export const owner = 'replacement';");
    const trailers = parseStellaCommitTrailers(
      commitBody(h.repoRoot, replacement!.commitHash),
    );
    expect(trailers.conversationId).toBe("replacement-conversation");
    expect(trailers.threadKey).toBe("replacement-thread");
    expect(commitBody(h.repoRoot, replacement!.commitHash)).not.toContain(
      "old-thread",
    );
  });

  it("failed run (succeeded: false) commits nothing", async () => {
    await h.service.beginSelfModRun({
      runId: "run-fail",
      taskDescription: "Failing run",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/fail.tsx", "export {};\n");
    const before = await getGitHead(h.repoRoot);
    const finalized = await h.service.finalizeSelfModRun({
      runId: "run-fail",
      succeeded: false,
    });
    expect(finalized).toBeNull();
    expect(await getGitHead(h.repoRoot)).toBe(before);
  });

  it("falls back to the task description when the subject provider fails, and truncates long subjects", async () => {
    await h.service.beginSelfModRun({
      runId: "run-subject-fallback",
      taskDescription: "Tidy up settings",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/s1.tsx", "export {};\n");
    const fallback = await h.service.finalizeSelfModRun({
      runId: "run-subject-fallback",
      succeeded: true,
      conversationId: "conv-s",
      commitMessageProvider: async () => {
        throw new Error("LLM unavailable");
      },
    });
    expect(commitBody(h.repoRoot, fallback!.commitHash)).toContain(
      "Tidy up settings",
    );

    await h.service.beginSelfModRun({
      runId: "run-subject-long",
      taskDescription: "Long subject run",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/s2.tsx", "export {};\n");
    const long = await h.service.finalizeSelfModRun({
      runId: "run-subject-long",
      succeeded: true,
      conversationId: "conv-s",
      commitMessageProvider: async () => "x".repeat(200),
    });
    const subject = git(h.repoRoot, [
      "show",
      "-s",
      "--format=%s",
      long!.commitHash,
    ]);
    expect(subject.length).toBeLessThanOrEqual(72);
  });

  it("drops invalid Stella-Thread trailer values instead of writing a malformed trailer", async () => {
    await h.service.beginSelfModRun({
      runId: "run-bad-thread",
      taskDescription: "Bad thread key",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/t.tsx", "export {};\n");
    const finalized = await h.service.finalizeSelfModRun({
      runId: "run-bad-thread",
      succeeded: true,
      conversationId: "conv-ok",
      threadKey: "spaces are not allowed!",
    });
    const trailers = parseStellaCommitTrailers(
      commitBody(h.repoRoot, finalized!.commitHash),
    );
    expect(trailers.conversationId).toBe("conv-ok");
    expect(trailers.threadKey).toBeUndefined();
  });

  it("records source history in the background, chained in commit order", async () => {
    await h.service.beginSelfModRun({ runId: "r1", taskDescription: "One" });
    await writeRepoFile(h.repoRoot, "desktop/src/one.tsx", "export {};\n");
    const first = await h.service.finalizeSelfModRun({
      runId: "r1",
      succeeded: true,
      conversationId: "conv-bg",
    });
    await h.service.beginSelfModRun({ runId: "r2", taskDescription: "Two" });
    await writeRepoFile(h.repoRoot, "desktop/src/two.tsx", "export {};\n");
    const second = await h.service.finalizeSelfModRun({
      runId: "r2",
      succeeded: true,
      conversationId: "conv-bg",
    });

    await h.service.waitForBackgroundTasks();
    const firstRecord = h.sourceHistory.findRevisionByCommit(first!.commitHash);
    const secondRecord = h.sourceHistory.findRevisionByCommit(
      second!.commitHash,
    );
    expect(firstRecord?.origin).toBe("self-mod");
    // Parent chaining requires the background queue to preserve order.
    expect(secondRecord?.parentRevisionIds).toEqual([firstRecord!.revisionId]);
  });

  it("author commits accrue to the durable feature roster and the snapshot is the roster head", async () => {
    await h.service.beginSelfModRun({ runId: "n1", taskDescription: "One" });
    await writeRepoFile(h.repoRoot, "desktop/src/n1.tsx", "export {};\n");
    const first = await h.service.finalizeSelfModRun({
      runId: "n1",
      succeeded: true,
      conversationId: "conv-n",
      featureId: "weather-dashboard",
      featureTitle: "Build a weather dashboard",
    });
    let snapshot = h.service.readFeatureSnapshot();
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0]).toMatchObject({
      featureId: "weather-dashboard",
      name: "Build a weather dashboard",
      commitHashes: [first!.commitHash],
    });

    // A later commit with the same feature id extends the SAME feature:
    // the name stays frozen even when a different title is supplied.
    await h.service.beginSelfModRun({ runId: "n2", taskDescription: "Two" });
    await writeRepoFile(h.repoRoot, "desktop/src/n2.tsx", "export {};\n");
    const second = await h.service.finalizeSelfModRun({
      runId: "n2",
      succeeded: true,
      conversationId: "conv-n",
      featureId: "weather-dashboard",
      featureTitle: "A churned rename that must not stick",
    });
    snapshot = h.service.readFeatureSnapshot();
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0]!.name).toBe("Build a weather dashboard");
    expect(snapshot?.items[0]!.commitHashes).toEqual(
      expect.arrayContaining([first!.commitHash, second!.commitHash]),
    );

    // Feature identity also lands as commit trailers (slugified title).
    const log = commitBody(h.repoRoot, second!.commitHash);
    expect(log).toContain("Stella-Feature-Id: weather-dashboard");
    expect(log).toContain(
      "Stella-Feature-Title: a-churned-rename-that-must-not-stick",
    );
  });

  it("detectSelfModAppliedSince reports the latest self-mod commit after a baseline", async () => {
    const baseline = await getGitHead(h.repoRoot);
    await h.service.beginSelfModRun({ runId: "d1", taskDescription: "Detect" });
    await writeRepoFile(h.repoRoot, "desktop/src/detect.tsx", "export {};\n");
    const finalized = await h.service.finalizeSelfModRun({
      runId: "d1",
      succeeded: true,
      conversationId: "conv-d",
    });

    const detected = await detectSelfModAppliedSince({
      repoRoot: h.repoRoot,
      sinceHead: baseline,
    });
    expect(detected?.commitHash).toBe(finalized!.commitHash);
    expect(detected?.files).toEqual(["desktop/src/detect.tsx"]);

    expect(
      await detectSelfModAppliedSince({
        repoRoot: h.repoRoot,
        sinceHead: finalized!.commitHash,
      }),
    ).toBeNull();
  });
});

describe("undo (revert)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const makeSelfModCommit = async (
    runId: string,
    relPath: string,
    content: string,
    conversationId: string,
    threadKey?: string,
  ) => {
    await h.service.beginSelfModRun({ runId, taskDescription: runId });
    await writeRepoFile(h.repoRoot, relPath, content);
    const finalized = await h.service.finalizeSelfModRun({
      runId,
      succeeded: true,
      conversationId,
      ...(threadKey ? { threadKey } : {}),
    });
    return finalized!;
  };

  it("reverts the latest self-mod commit and reads attribution from the original commit", async () => {
    await makeSelfModCommit(
      "u1",
      "desktop/src/undo.tsx",
      "export const v = 1;\n",
      "conv-undo",
      "thread-undo",
    );

    const result = await revertSelfModCommit({ repoRoot: h.repoRoot });
    expect(result.revertedCommitHashes).toHaveLength(1);
    expect(result.conversationId).toBe("conv-undo");
    expect(result.originThreadKey).toBe("thread-undo");
    expect(result.files).toEqual(["desktop/src/undo.tsx"]);
    // The file the commit created is gone again.
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/undo.tsx"), "utf8"),
    ).rejects.toThrow();
    // History gained a revert commit (no history rewriting).
    expect(git(h.repoRoot, ["show", "-s", "--format=%s", "HEAD"])).toContain(
      "Revert",
    );
  });

  it("supports undoing two changes one after the other", async () => {
    const first = await makeSelfModCommit(
      "u-first",
      "desktop/src/first.tsx",
      "export const first = 1;\n",
      "conv-1",
    );
    const second = await makeSelfModCommit(
      "u-second",
      "desktop/src/second.tsx",
      "export const second = 1;\n",
      "conv-2",
    );

    const undoSecond = await revertSelfModCommit({
      repoRoot: h.repoRoot,
      commitHash: second.commitHash,
    });
    expect(undoSecond.conversationId).toBe("conv-2");
    const undoFirst = await revertSelfModCommit({
      repoRoot: h.repoRoot,
      commitHash: first.commitHash,
    });
    expect(undoFirst.conversationId).toBe("conv-1");

    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/first.tsx"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/second.tsx"), "utf8"),
    ).rejects.toThrow();
  });

  it("refuses to revert a non-self-mod commit", async () => {
    await writeRepoFile(h.repoRoot, "plain.txt", "user content\n");
    git(h.repoRoot, ["add", "plain.txt"]);
    git(h.repoRoot, ["commit", "-q", "-m", "Plain user commit"]);
    const plainHash = await getGitHead(h.repoRoot);

    await expect(
      revertSelfModCommit({ repoRoot: h.repoRoot, commitHash: plainHash! }),
    ).rejects.toThrow(/Refusing to revert/);
  });

  it("refuses multi-step reverts (attribution would collapse)", async () => {
    await makeSelfModCommit(
      "u-multi",
      "desktop/src/multi.tsx",
      "export {};\n",
      "conv-multi",
    );
    await expect(
      revertSelfModCommit({ repoRoot: h.repoRoot, steps: 2 }),
    ).rejects.toThrow(/steps=2/);
  });
});

describe("store uninstall", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const makeInstallCommit = async (
    runId: string,
    packageId: string,
    relPath: string,
  ): Promise<string> => {
    await h.service.beginSelfModRun({
      runId,
      taskDescription: `Install ${packageId}`,
      packageId,
      releaseNumber: 1,
      applyMode: "install",
    });
    await writeRepoFile(h.repoRoot, relPath, `// ${packageId}\n`);
    const finalized = await h.service.finalizeSelfModRun({
      runId,
      succeeded: true,
      conversationId: `store-install:${packageId}`,
      threadKey: `store-install:${packageId}`,
    });
    return finalized!.commitHash;
  };

  it("direct-reverts a clean tip install stack and clears the ledger", async () => {
    const c1 = await makeInstallCommit(
      "i1",
      "quiet-mode",
      "desktop/src/q1.tsx",
    );
    const c2 = await makeInstallCommit(
      "i2",
      "quiet-mode",
      "desktop/src/q2.tsx",
    );
    h.service.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 1,
      installCommitHash: c1,
    });
    h.service.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 1,
      installCommitHash: c2,
    });
    // recordInstall appends commit hashes for the same package.
    const install = h.service.getInstall("quiet-mode");
    expect(install?.installCommitHashes).toEqual([c1, c2]);

    const result = await h.service.uninstall("quiet-mode");
    expect(result.fallbackRequired).toBe(false);
    expect(result.revertedCommits).toEqual([c2, c1]);
    expect(h.service.getInstall("quiet-mode")).toBeNull();
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/q1.tsx"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/q2.tsx"), "utf8"),
    ).rejects.toThrow();
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);
  });

  it("requires the agent fallback when the working tree is dirty", async () => {
    const c1 = await makeInstallCommit(
      "i-dirty",
      "noisy-mode",
      "desktop/src/n1.tsx",
    );
    h.service.recordInstall({
      packageId: "noisy-mode",
      releaseNumber: 1,
      installCommitHash: c1,
    });
    await writeRepoFile(h.repoRoot, "desktop/src/wip.tsx", "// user WIP\n");

    const result = await h.service.uninstall("noisy-mode");
    expect(result.fallbackRequired).toBe(true);
    expect(result.reason).toContain("not clean");
    // Nothing reverted, ledger intact.
    expect(result.revertedCommits).toEqual([]);
    expect(h.service.getInstall("noisy-mode")).not.toBeNull();
  });

  it("direct-reverts a buried install when later edits do not overlap", async () => {
    const c1 = await makeInstallCommit(
      "i-old",
      "old-mode",
      "desktop/src/o1.tsx",
    );
    h.service.recordInstall({
      packageId: "old-mode",
      releaseNumber: 1,
      installCommitHash: c1,
    });
    // A later unrelated self-mod commit buries the install. Because it touches
    // a different file, the add-on's inverse patch still applies cleanly at
    // HEAD, so uninstall reverts it directly without dropping to the agent
    // fallback (the agent is only needed when a later edit overlaps the
    // add-on's own lines).
    await h.service.beginSelfModRun({
      runId: "later",
      taskDescription: "Later work",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/later.tsx", "export {};\n");
    await h.service.finalizeSelfModRun({
      runId: "later",
      succeeded: true,
      conversationId: "conv-later",
    });

    const result = await h.service.uninstall("old-mode");
    expect(result.fallbackRequired).toBe(false);
    expect(result.revertedCommits).toEqual([c1]);
    expect(h.service.getInstall("old-mode")).toBeNull();
    // The add-on's own file is gone; the later, unrelated edit survives and the
    // tree is left clean.
    await expect(
      readFile(path.join(h.repoRoot, "desktop/src/o1.tsx"), "utf8"),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(h.repoRoot, "desktop/src/later.tsx"), "utf8"),
    ).toBe("export {};\n");
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);
  });

  it("revertGitCommits resets back to the pre-revert HEAD when a mid-stack revert fails", async () => {
    // Reverting the same commit twice forces a mid-sequence conflict: the
    // first revert succeeds, the second tries to re-apply the inverse diff
    // onto already-reverted content.
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/seed.tsx",
      "export const seed = 2;\n",
    );
    git(h.repoRoot, ["add", "."]);
    git(h.repoRoot, ["commit", "-q", "-m", "Bump seed"]);
    const bump = (await getGitHead(h.repoRoot))!;

    await expect(
      revertGitCommits({
        repoRoot: h.repoRoot,
        commitHashes: [bump, bump],
        resetToPreRevertHeadOnFailure: true,
      }),
    ).rejects.toThrow();
    // Atomic: the successful first revert did not survive.
    expect(await getGitHead(h.repoRoot)).toBe(bump);
    expect(await listGitDirtyFiles(h.repoRoot)).toEqual([]);
  });
});

describe("commit listing and ordering", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("lists publishable self-mod commits with batched per-commit files, excluding plain and store-apply commits", async () => {
    const hashes: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      await h.service.beginSelfModRun({
        runId: `list-${index}`,
        taskDescription: `Change ${index}`,
      });
      await writeRepoFile(
        h.repoRoot,
        `desktop/src/file-${index}.tsx`,
        `export const v = ${index};\n`,
      );
      await writeRepoFile(
        h.repoRoot,
        `desktop/src/helper-${index}.ts`,
        `export const helper = ${index};\n`,
      );
      const finalized = await h.service.finalizeSelfModRun({
        runId: `list-${index}`,
        succeeded: true,
        conversationId: `conv-${index}`,
      });
      hashes.push(finalized!.commitHash);
    }

    // A plain user commit and an install-mode commit must not surface.
    await writeRepoFile(h.repoRoot, "plain.txt", "plain\n");
    git(h.repoRoot, ["add", "plain.txt"]);
    git(h.repoRoot, ["commit", "-q", "-m", "Plain user commit"]);
    await h.service.beginSelfModRun({
      runId: "install-x",
      taskDescription: "Install pkg",
      packageId: "pkg-x",
      releaseNumber: 3,
      applyMode: "install",
    });
    await writeRepoFile(h.repoRoot, "desktop/src/pkg.tsx", "export {};\n");
    await h.service.finalizeSelfModRun({
      runId: "install-x",
      succeeded: true,
      conversationId: "store-install:pkg-x",
    });

    const commits = await listRecentGitCommits(h.repoRoot, 50);
    expect(commits.map((commit) => commit.commitHash)).toEqual(
      [...hashes].reverse(),
    );
    for (const [index, hash] of [...hashes].reverse().entries()) {
      const summary = commits[index]!;
      expect(summary.commitHash).toBe(hash);
      expect(summary.fileCount).toBe(2);
      expect(summary.files.sort()).toEqual(
        [
          `desktop/src/file-${4 - index}.tsx`,
          `desktop/src/helper-${4 - index}.ts`,
        ].sort(),
      );
      expect(summary.conversationId).toBe(`conv-${4 - index}`);
      expect(summary.body).not.toContain("Stella-Conversation");
    }
  });

  it("marks recent self-mod commits tainted when their files are dirty again", async () => {
    await h.service.beginSelfModRun({ runId: "t1", taskDescription: "Taint" });
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/taint.tsx",
      "export const t = 1;\n",
    );
    const finalized = await h.service.finalizeSelfModRun({
      runId: "t1",
      succeeded: true,
      conversationId: "conv-t",
    });

    let summaries = await listRecentSelfModCommits(h.repoRoot, 5);
    expect(summaries[0]?.commitHash).toBe(finalized!.commitHash);
    expect(summaries[0]?.tainted).toBeUndefined();

    await writeRepoFile(
      h.repoRoot,
      "desktop/src/taint.tsx",
      "export const t = 2;\n",
    );
    summaries = await listRecentSelfModCommits(h.repoRoot, 5);
    expect(summaries[0]?.tainted).toBe(true);
    expect(summaries[0]?.taintedFiles).toEqual(["desktop/src/taint.tsx"]);
  });

  it("orders shuffled linear commits topologically without walking unrelated history", async () => {
    const hashes: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await writeRepoFile(
        h.repoRoot,
        `desktop/src/o-${index}.ts`,
        `// ${index}\n`,
      );
      git(h.repoRoot, ["add", "."]);
      git(h.repoRoot, ["commit", "-q", "-m", `Ordered ${index}`]);
      hashes.push((await getGitHead(h.repoRoot))!);
    }
    const shuffled = [hashes[2]!, hashes[0]!, hashes[3]!, hashes[1]!];
    expect(
      await orderCommitHashesChronologically({
        repoRoot: h.repoRoot,
        commitHashes: shuffled,
      }),
    ).toEqual(hashes);
  });

  it("orders branch + merge selections with the merge last, and falls back to timestamps for disconnected history", async () => {
    const base = (await getGitHead(h.repoRoot))!;
    // Branch commit.
    git(h.repoRoot, ["checkout", "-q", "-b", "side"]);
    await writeRepoFile(h.repoRoot, "desktop/src/side.ts", "// side\n");
    git(h.repoRoot, ["add", "."]);
    git(h.repoRoot, ["commit", "-q", "-m", "Side change"]);
    const side = (await getGitHead(h.repoRoot))!;
    // Main commit.
    git(h.repoRoot, ["checkout", "-q", "main"]);
    await writeRepoFile(h.repoRoot, "desktop/src/main.ts", "// main\n");
    git(h.repoRoot, ["add", "."]);
    git(h.repoRoot, ["commit", "-q", "-m", "Main change"]);
    const mainChange = (await getGitHead(h.repoRoot))!;
    git(h.repoRoot, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
    const merge = (await getGitHead(h.repoRoot))!;

    const ordered = await orderCommitHashesChronologically({
      repoRoot: h.repoRoot,
      commitHashes: [merge, side, mainChange],
    });
    expect(ordered).toHaveLength(3);
    expect(ordered[2]).toBe(merge);
    expect(new Set(ordered.slice(0, 2))).toEqual(new Set([side, mainChange]));

    // Disconnected history: an orphan commit shares no merge-base; the
    // timestamp fallback still produces a stable, complete ordering.
    git(h.repoRoot, ["checkout", "-q", "--orphan", "orphan"]);
    git(h.repoRoot, ["rm", "-r", "-q", "--cached", "."]);
    await writeRepoFile(h.repoRoot, "orphan.txt", "island\n");
    git(h.repoRoot, ["add", "orphan.txt"]);
    git(h.repoRoot, ["commit", "-q", "-m", "Orphan island"], {
      GIT_AUTHOR_DATE: "2030-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2030-01-01T00:00:00",
    });
    const orphan = (await getGitHead(h.repoRoot))!;
    git(h.repoRoot, ["checkout", "-qf", "main"]);

    const fallback = await orderCommitHashesChronologically({
      repoRoot: h.repoRoot,
      commitHashes: [orphan, base],
    });
    expect(fallback).toEqual([base, orphan]);
  });

  it("throws a structured error for unresolved hashes", async () => {
    await expect(
      orderCommitHashesChronologically({
        repoRoot: h.repoRoot,
        commitHashes: ["0".repeat(40)],
      }),
    ).rejects.toThrow(/Could not resolve 1 commit hash/);
  });
});

describe("readGitObjectsBatch", () => {
  it("reads base+next blobs for a commit in one batch, mapping missing paths to null", async () => {
    const h = await createHarness();
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/seed.tsx",
      "export const seed = 2;\n",
    );
    await writeRepoFile(
      h.repoRoot,
      "desktop/src/new.tsx",
      "export const fresh = 1;\n",
    );
    git(h.repoRoot, ["add", "."]);
    git(h.repoRoot, ["commit", "-q", "-m", "Second commit"]);
    const head = (await getGitHead(h.repoRoot))!;
    const parent = git(h.repoRoot, ["rev-parse", "HEAD^"]);

    const objects = await readGitObjectsBatch({
      repoRoot: h.repoRoot,
      specs: [
        `${parent}:desktop/src/seed.tsx`,
        `${head}:desktop/src/seed.tsx`,
        `${parent}:desktop/src/new.tsx`,
        `${head}:desktop/src/new.tsx`,
      ],
    });

    expect(
      objects.get(`${parent}:desktop/src/seed.tsx`)?.toString("utf8"),
    ).toBe("export const seed = 1;\n");
    expect(objects.get(`${head}:desktop/src/seed.tsx`)?.toString("utf8")).toBe(
      "export const seed = 2;\n",
    );
    expect(objects.get(`${parent}:desktop/src/new.tsx`)).toBeNull();
    expect(objects.get(`${head}:desktop/src/new.tsx`)?.toString("utf8")).toBe(
      "export const fresh = 1;\n",
    );
  });
});
