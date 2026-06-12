import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { buildStellaSourceChangeSetForGitCommit } from "../../../../../runtime/kernel/self-mod/stella-source-history.js";

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

describe("StoreModService source history", () => {
  let repoRoot = "";
  let dbRoot = "";
  let db: SqliteDatabase;
  let sourceHistory: StellaSourceHistoryStore;
  let service: StoreModService;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-source-service-"));
    dbRoot = await mkdtemp(path.join(os.tmpdir(), "stella-source-db-"));
    git(repoRoot, ["init", "-q", "-b", "main"]);
    git(repoRoot, ["config", "user.email", "test@stella.local"]);
    git(repoRoot, ["config", "user.name", "Stella Test"]);
    git(repoRoot, ["config", "commit.gpgsign", "false"]);
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "copy.ts"), "one\n", "utf8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "Initial"]);

    db = new DatabaseSync(getDesktopDatabasePath(dbRoot), {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    sourceHistory = new StellaSourceHistoryStore(db);
    service = new StoreModService(
      repoRoot,
      new StoreModStore(db),
      sourceHistory,
    );
  });

  afterEach(async () => {
    db.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbRoot, { recursive: true, force: true });
  });

  it("records chained hash-only source revisions for self-mod commits", async () => {
    const initialCommit = git(repoRoot, ["rev-parse", "HEAD"]);

    await service.beginSelfModRun({
      runId: "run-1",
      taskDescription: "Edit copy",
    });
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "one\ntwo\n",
      "utf8",
    );
    const first = await service.finalizeSelfModRun({
      runId: "run-1",
      succeeded: true,
      conversationId: "conv-1",
      threadKey: "thread-1",
    });

    // Author-mode commits record source history in the background (off
    // the apply critical path); the result carries no sourceRevisionId.
    expect(first?.sourceRevisionId).toBeUndefined();
    await service.waitForBackgroundTasks();
    const firstRecord = sourceHistory.findRevisionByCommit(first!.commitHash);
    expect(firstRecord).toBeTruthy();
    expect(firstRecord?.origin).toBe("self-mod");
    // The trailer feature id (threadKey when ungrouped) is the canonical
    // source-history feature identity for author commits.
    expect(firstRecord?.featureId).toBe("thread-1");
    expect(firstRecord?.parentRevisionIds).toEqual([`git:${initialCommit}`]);
    expect(firstRecord?.changeSet.changes[0]).not.toHaveProperty("base");
    expect(firstRecord?.changeSet.changes[0]).not.toHaveProperty("next");

    await service.beginSelfModRun({
      runId: "run-2",
      taskDescription: "Edit copy again",
    });
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    const second = await service.finalizeSelfModRun({
      runId: "run-2",
      succeeded: true,
      conversationId: "conv-1",
      threadKey: "thread-1",
    });
    await service.waitForBackgroundTasks();

    const secondRecord = sourceHistory.findRevisionByCommit(second!.commitHash);
    expect(secondRecord?.parentRevisionIds).toEqual([firstRecord!.revisionId]);
    expect(
      sourceHistory
        .listFeatureRevisions("thread-1")
        .map((record) => record.revisionId),
    ).toEqual([firstRecord!.revisionId, secondRecord!.revisionId]);
  });

  it("records Store installs as package-scoped source revisions", async () => {
    await service.beginSelfModRun({
      runId: "install-1",
      taskDescription: "Install Quiet Mode from Store source pack",
      packageId: "quiet-mode",
      releaseNumber: 2,
      applyMode: "install",
    });
    await writeFile(
      path.join(repoRoot, "src", "quiet.ts"),
      "export const quiet = true;\n",
      "utf8",
    );
    const result = await service.finalizeSelfModRun({
      runId: "install-1",
      succeeded: true,
      conversationId: "store-install:quiet-mode",
      threadKey: "store-install:quiet-mode",
    });

    const record = sourceHistory.findRevisionByCommit(result!.commitHash);
    expect(record).toMatchObject({
      origin: "store-install",
      packageId: "quiet-mode",
      releaseNumber: 2,
      featureId: "store:quiet-mode",
    });
  });

  it("records install-update agent commits as desktop-update revisions", async () => {
    await service.beginSelfModRun({
      runId: "desktop-update-1",
      taskDescription: "Update to desktop-v1",
      applyMode: "desktop-update",
    });
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "one\ntwo\nfrom desktop update\n",
      "utf8",
    );
    const result = await service.finalizeSelfModRun({
      runId: "desktop-update-1",
      succeeded: true,
      conversationId: "install-update-conv",
      threadKey: "install-update-conv",
    });

    const record = sourceHistory.findRevisionByCommit(result!.commitHash);
    expect(record).toMatchObject({
      origin: "desktop-update",
      featureId: "self-mod:install-update-conv",
      description: "Desktop update",
    });
  });

  it("uses a local desktop-update commit alias as the parent source revision", async () => {
    const initialCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "one\nfrom desktop source pack\n",
      "utf8",
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "Update to desktop-v2"]);
    const localUpdateCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    const upstreamReleaseCommit = "f".repeat(40);
    const { changeSet } = await buildStellaSourceChangeSetForGitCommit({
      repoRoot,
      commitHash: localUpdateCommit,
      parentRevisionId: `git:${initialCommit}`,
      featureId: "desktop-release",
      description: "Desktop release v2",
    });
    sourceHistory.recordRevision({
      changeSet,
      origin: "desktop-update",
      commitHash: localUpdateCommit,
    });
    sourceHistory.recordRevision({
      changeSet,
      origin: "official",
      commitHash: upstreamReleaseCommit,
    });

    await service.beginSelfModRun({
      runId: "after-desktop-update",
      taskDescription: "User customization",
    });
    await writeFile(
      path.join(repoRoot, "src", "copy.ts"),
      "one\nfrom desktop source pack\nuser customization\n",
      "utf8",
    );
    const result = await service.finalizeSelfModRun({
      runId: "after-desktop-update",
      succeeded: true,
      conversationId: "conv-after-update",
      threadKey: "thread-after-update",
    });
    await service.waitForBackgroundTasks();

    const record = sourceHistory.findRevisionByCommit(result!.commitHash);
    expect(record?.parentRevisionIds).toEqual([changeSet.revisionId]);
    expect(
      sourceHistory.findRevisionByCommit(localUpdateCommit)?.revisionId,
    ).toBe(changeSet.revisionId);
    expect(
      sourceHistory.findRevisionByCommit(upstreamReleaseCommit)?.revisionId,
    ).toBe(changeSet.revisionId);
  });
});
