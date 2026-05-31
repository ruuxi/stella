import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStellaSourcePack } from "../../../../runtime/kernel/self-mod/stella-source-control.js";
import { buildStellaSourceChangeSetForGitCommit } from "../../../../runtime/kernel/self-mod/stella-source-history.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import { StellaSourceHistoryStore } from "../../../../runtime/kernel/storage/stella-source-history-store.js";
import {
  buildStoreReleaseRedactor,
  collectStoreReleaseCommits,
  collectStoreReleaseSourcePack,
} from "../../../../runtime/worker/store-thread-helpers.js";

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const text = (content: string) => ({ kind: "text" as const, content });

const initRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "stella-store-pack-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@stella.local"]);
  git(repoRoot, ["config", "user.name", "Stella Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src/feature.ts"), "one\ntwo\n", "utf8");
  await writeFile(
    path.join(repoRoot, "src/untouched.ts"),
    "do not publish this file\n",
    "utf8",
  );
  git(repoRoot, ["add", "src"]);
  git(repoRoot, ["commit", "-q", "-m", "Initial seed"]);
  return repoRoot;
};

describe("Store release redaction", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = await initRepo();
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("redacts email addresses from text leaving the author's machine", () => {
    const redact = buildStoreReleaseRedactor();

    expect(
      redact("Author: Stella User <publisher@example-company.com>"),
    ).toBe("Author: Stella User <<redacted-email>>");
  });

  it("omits git commit metadata and redacts emails from Store reference commits", async () => {
    git(repoRoot, ["config", "user.email", "publisher@example-company.com"]);
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "export const owner = 'publisher@example-company.com';\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Add publisher@example-company.com feature",
      "-m",
      "Stella-Conversation: conv-email",
    ]);
    const commitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    const commits = await collectStoreReleaseCommits({
      repoRoot,
      attachedFeatureNames: ["Email Feature"],
      snapshot: {
        generatedAt: Date.now(),
        items: [
          {
            name: "Email Feature",
            commitHashes: [commitHash],
          },
        ],
      },
    });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe("Add <redacted-email> feature");
    expect(commits[0]?.diff).not.toContain("Author:");
    expect(commits[0]?.diff).not.toContain("publisher@example-company.com");
    expect(commits[0]?.diff).toContain("<redacted-email>");
  });
});

describe("collectStoreReleaseSourcePack", () => {
  let repoRoot = "";
  let dbRoot = "";
  let db: SqliteDatabase | null = null;

  beforeEach(async () => {
    repoRoot = await initRepo();
    dbRoot = await mkdtemp(path.join(os.tmpdir(), "stella-store-pack-db-"));
  });

  afterEach(async () => {
    db?.close();
    db = null;
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbRoot, { recursive: true, force: true });
  });

  it("builds an installable source pack from grouped self-mod commits", async () => {
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Extend feature",
      "-m",
      "Stella-Conversation: conv-pack",
    ]);
    const firstCommit = git(repoRoot, ["rev-parse", "HEAD"]);

    await writeFile(
      path.join(repoRoot, "src/settings.ts"),
      "export const enabled = true;\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/settings.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Add feature setting",
      "-m",
      "Stella-Conversation: conv-pack",
    ]);
    const secondCommit = git(repoRoot, ["rev-parse", "HEAD"]);

    const sourcePack = await collectStoreReleaseSourcePack({
      repoRoot,
      attachedFeatureNames: ["Feature Pack"],
      snapshot: {
        generatedAt: Date.now(),
        // Deliberately newest-first, matching the UI snapshot contract.
        items: [
          {
            name: "Feature Pack",
            commitHashes: [secondCommit, firstCommit],
          },
        ],
      },
    });

    expect(sourcePack).toBeTruthy();
    expect(sourcePack?.changeSets).toHaveLength(2);
    expect(JSON.stringify(sourcePack)).not.toContain(
      "do not publish this file",
    );

    const result = applyStellaSourcePack({
      pack: sourcePack!,
      localTree: {
        "src/feature.ts": text("ONE\ntwo\n"),
      },
    });

    expect(result.status).toBe("clean");
    expect(result.tree).toEqual({
      "src/feature.ts": text("ONE\ntwo\nthree\n"),
      "src/settings.ts": text("export const enabled = true;\n"),
    });
  });

  it("keeps dependency manifests and lockfiles in Store source packs", async () => {
    await writeFile(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(repoRoot, "bun.lock"), "lock-v1\n", "utf8");
    git(repoRoot, ["add", "package.json", "bun.lock"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Add dependency",
      "-m",
      "Stella-Conversation: conv-deps",
    ]);
    const commitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    const sourcePack = await collectStoreReleaseSourcePack({
      repoRoot,
      attachedFeatureNames: ["Dependency Feature"],
      snapshot: {
        generatedAt: Date.now(),
        items: [
          {
            name: "Dependency Feature",
            commitHashes: [commitHash],
          },
        ],
      },
    });

    expect(
      sourcePack?.changeSets.flatMap((changeSet) =>
        changeSet.changes.map((change) => change.path),
      ),
    ).toEqual(["bun.lock", "package.json"]);
  });

  it("preserves persisted Stella source revision ids when publishing from local history", async () => {
    db = new DatabaseSync(getDesktopDatabasePath(dbRoot), {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    const sourceHistory = new StellaSourceHistoryStore(db);

    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Extend feature",
      "-m",
      "Stella-Conversation: conv-pack",
    ]);
    const firstCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    const firstChangeSet = await buildStellaSourceChangeSetForGitCommit({
      repoRoot,
      commitHash: firstCommit,
      featureId: "self-mod:conv-pack",
      description: "Extend feature",
    });
    const firstRecord = sourceHistory.recordRevision({
      changeSet: firstChangeSet.changeSet,
      origin: "self-mod",
      commitHash: firstCommit,
      featureId: "self-mod:conv-pack",
      description: "Extend feature",
      createdAt: 1_000,
    });

    await writeFile(
      path.join(repoRoot, "src/settings.ts"),
      "export const enabled = true;\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/settings.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Add feature setting",
      "-m",
      "Stella-Conversation: conv-pack",
    ]);
    const secondCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    const secondChangeSet = await buildStellaSourceChangeSetForGitCommit({
      repoRoot,
      commitHash: secondCommit,
      parentRevisionId: firstRecord.revisionId,
      featureId: "self-mod:conv-pack",
      description: "Add feature setting",
    });
    const secondRecord = sourceHistory.recordRevision({
      changeSet: secondChangeSet.changeSet,
      origin: "self-mod",
      commitHash: secondCommit,
      featureId: "self-mod:conv-pack",
      description: "Add feature setting",
      createdAt: 2_000,
    });

    const sourcePack = await collectStoreReleaseSourcePack({
      repoRoot,
      attachedFeatureNames: ["Feature Pack"],
      snapshot: {
        generatedAt: Date.now(),
        items: [
          {
            name: "Feature Pack",
            commitHashes: [secondCommit, firstCommit],
          },
        ],
      },
      sourceHistory,
    });

    expect(
      sourcePack?.changeSets.map((changeSet) => changeSet.revisionId),
    ).toEqual([firstRecord.revisionId, secondRecord.revisionId]);
    expect(sourcePack?.changeSets[1]?.parentRevisionIds).toEqual([
      firstRecord.revisionId,
    ]);
    expect(sourcePack?.changeSets[0]?.changes[0]).toHaveProperty("base");
    expect(sourcePack?.changeSets[0]?.changes[0]).toHaveProperty("next");

    const result = applyStellaSourcePack({
      pack: sourcePack!,
      localTree: {
        "src/feature.ts": text("ONE\ntwo\n"),
      },
    });
    expect(result.status).toBe("clean");
  });

  it("skips direct source packs when touched source would need redaction", async () => {
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "export const token = 'sk-testsecret12345678901234567890';\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Add connected feature",
      "-m",
      "Stella-Conversation: conv-redacted",
    ]);
    const commitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    const sourcePack = await collectStoreReleaseSourcePack({
      repoRoot,
      attachedFeatureNames: ["Connected Feature"],
      snapshot: {
        generatedAt: Date.now(),
        items: [
          {
            name: "Connected Feature",
            commitHashes: [commitHash],
          },
        ],
      },
    });

    expect(sourcePack).toBeUndefined();
  });

  it("skips direct source packs when touched source is too large to embed", async () => {
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      `${"x".repeat(500_001)}\n`,
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, [
      "commit",
      "-q",
      "-m",
      "Add large feature source",
      "-m",
      "Stella-Conversation: conv-large",
    ]);
    const commitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    const sourcePack = await collectStoreReleaseSourcePack({
      repoRoot,
      attachedFeatureNames: ["Large Feature"],
      snapshot: {
        generatedAt: Date.now(),
        items: [
          {
            name: "Large Feature",
            commitHashes: [commitHash],
          },
        ],
      },
    });

    expect(sourcePack).toBeUndefined();
  });
});
