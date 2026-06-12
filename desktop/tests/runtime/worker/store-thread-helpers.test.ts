import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStorePublishFeatureSnapshot,
  buildStoreReleaseRedactor,
  collectStoreReleaseCommits,
  collectStoreReleaseGitArtifact,
  normalizeStoreThreadFeatureIds,
  normalizeStoreThreadFeatureNames,
} from "../../../../runtime/worker/store-thread-helpers.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import { StoreModStore } from "../../../../runtime/kernel/storage/store-mod-store.js";

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

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
  const releaseCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(repoRoot, "stella-install.json"),
    `${JSON.stringify({ desktopReleaseCommit: releaseCommit }, null, 2)}\n`,
    "utf8",
  );
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

    expect(redact("Author: Stella User <publisher@example-company.com>")).toBe(
      "Author: Stella User <<redacted-email>>",
    );
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

  it("builds a sanitized git-object Store artifact", async () => {
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "export const owner = 'publisher@example-company.com';\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Add email literal"]);
    const commitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    const artifact = await collectStoreReleaseGitArtifact({
      repoRoot,
      attachedFeatureNames: ["Email Feature"],
      snapshot: {
        generatedAt: Date.now(),
        items: [{ name: "Email Feature", commitHashes: [commitHash] }],
      },
    });

    expect(artifact?.gitArtifact.kind).toBe("git-object-artifact");
    expect(artifact?.gitArtifact.baseCommit).toBe(
      git(repoRoot, ["rev-parse", "HEAD^"]),
    );
    expect(artifact?.gitArtifact.featureCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact?.gitArtifact.security?.redactedPaths).toEqual([
      "src/feature.ts",
    ]);
    expect(artifact?.diff).toContain("<redacted-email>");
    expect(artifact?.diff).not.toContain("publisher@example-company.com");
    expect(
      artifact?.objectUploads.some(
        (object) => object.sha === artifact.gitArtifact.featureCommit,
      ),
    ).toBe(true);

    const publishedContent = git(repoRoot, [
      "show",
      `${artifact!.gitArtifact.featureCommit}:src/feature.ts`,
    ]);
    expect(publishedContent).toContain("<redacted-email>");
    expect(publishedContent).not.toContain("publisher@example-company.com");
  });

  it("falls back to a snapshot squash when the publish base moved past the feature", async () => {
    // Mirror the prod failure: the feature commit was authored against an
    // older release, then a Stella update merged upstream edits adjacent to
    // the feature's hunks and the install manifest base moved forward.
    const seedCommit = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["checkout", "-q", "-b", "release", seedCommit]);
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "import upstream\none\ntwo\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Upstream release edit"]);
    const newBaseCommit = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["checkout", "-q", "main"]);
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "import feature\none\ntwo\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Feature edit"]);
    const featureCommitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    // Update merge: conflicts, resolved keeping both edits (what the
    // install-update agent produces on the user's machine).
    spawnSync("git", ["merge", "release"], { cwd: repoRoot, encoding: "utf8" });
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "import upstream\nimport feature\none\ntwo\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, ["commit", "-q", "--no-edit"]);

    await writeFile(
      path.join(repoRoot, "stella-install.json"),
      `${JSON.stringify({ desktopReleaseCommit: newBaseCommit }, null, 2)}\n`,
      "utf8",
    );

    const artifact = await collectStoreReleaseGitArtifact({
      repoRoot,
      attachedFeatureNames: ["Drifted Feature"],
      snapshot: {
        generatedAt: Date.now(),
        items: [
          { name: "Drifted Feature", commitHashes: [featureCommitHash] },
        ],
      },
    });

    expect(artifact?.gitArtifact.baseCommit).toBe(newBaseCommit);
    const publishedContent = git(repoRoot, [
      "show",
      `${artifact!.gitArtifact.featureCommit}:src/feature.ts`,
    ]);
    expect(publishedContent).toBe(
      "import upstream\nimport feature\none\ntwo",
    );
    expect(
      artifact?.gitArtifact.security?.warnings.some((warning) =>
        warning.includes("src/feature.ts"),
      ),
    ).toBe(true);
    expect(artifact?.diff).toContain("+import feature");
    expect(artifact?.diff).not.toContain("-import upstream");
  });

  it("blocks git-object Store publish when source contains an API key", async () => {
    await writeFile(
      path.join(repoRoot, "src/feature.ts"),
      "export const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/feature.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Add key literal"]);
    const commitHash = git(repoRoot, ["rev-parse", "HEAD"]);

    await expect(
      collectStoreReleaseGitArtifact({
        repoRoot,
        attachedFeatureNames: ["Key Feature"],
        snapshot: {
          generatedAt: Date.now(),
          items: [{ name: "Key Feature", commitHashes: [commitHash] }],
        },
      }),
    ).rejects.toThrow(/credential|API key/i);
  });
});

describe("Store publish feature selection resolution", () => {
  let repoRoot = "";
  let olderCommit = "";
  let newerCommit = "";

  // Roster feature names are NOT unique: two threads with the same
  // description freeze the same name onto two distinct features. The
  // snapshot lists newest-first, so name-only resolution always lands on
  // the newer one — ids are what pin a selection to the right commits.
  const duplicateNameSnapshot = () => ({
    generatedAt: Date.now(),
    items: [
      {
        name: "Status Widget",
        featureId: "feat-newer",
        commitHashes: [newerCommit],
      },
      {
        name: "Status Widget",
        featureId: "feat-older",
        commitHashes: [olderCommit],
      },
    ],
  });

  beforeEach(async () => {
    repoRoot = await initRepo();
    await writeFile(
      path.join(repoRoot, "src/older.ts"),
      "export const older = true;\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/older.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Older duplicate feature"]);
    olderCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repoRoot, "src/newer.ts"),
      "export const newer = true;\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/newer.ts"]);
    git(repoRoot, ["commit", "-q", "-m", "Newer duplicate feature"]);
    newerCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("resolves a same-named feature by its featureId instead of first name match", async () => {
    const commits = await collectStoreReleaseCommits({
      repoRoot,
      attachedFeatureNames: ["Status Widget"],
      attachedFeatureIds: ["feat-older"],
      snapshot: duplicateNameSnapshot(),
    });

    expect(commits.map((commit) => commit.hash)).toEqual([olderCommit]);
  });

  it("publishes the union of commit sets when both same-named features are selected", async () => {
    const commits = await collectStoreReleaseCommits({
      repoRoot,
      attachedFeatureNames: ["Status Widget", "Status Widget"],
      attachedFeatureIds: ["feat-older", "feat-newer"],
      snapshot: duplicateNameSnapshot(),
    });

    expect(commits.map((commit) => commit.hash)).toEqual([
      olderCommit,
      newerCommit,
    ]);
  });

  it("falls back to name resolution for legacy selections without ids", async () => {
    const withoutIdsArray = await collectStoreReleaseCommits({
      repoRoot,
      attachedFeatureNames: ["Status Widget"],
      snapshot: duplicateNameSnapshot(),
    });
    expect(withoutIdsArray.map((commit) => commit.hash)).toEqual([
      newerCommit,
    ]);

    const withBlankIdPlaceholder = await collectStoreReleaseCommits({
      repoRoot,
      attachedFeatureNames: ["Status Widget"],
      attachedFeatureIds: [""],
      snapshot: duplicateNameSnapshot(),
    });
    expect(withBlankIdPlaceholder.map((commit) => commit.hash)).toEqual([
      newerCommit,
    ]);
  });
});

describe("Store publish selection limit", () => {
  it("accepts up to 12 selected changes", () => {
    const names = Array.from({ length: 12 }, (_, index) => `Feature ${index}`);
    expect(normalizeStoreThreadFeatureNames(names)).toHaveLength(12);
    expect(
      normalizeStoreThreadFeatureIds(
        names.map((_, index) => `feat-${index}`),
      ),
    ).toHaveLength(12);
  });

  it("throws loudly instead of silently truncating more than 12 selections", () => {
    const names = Array.from({ length: 13 }, (_, index) => `Feature ${index}`);
    expect(() => normalizeStoreThreadFeatureNames(names)).toThrow(
      /at most 12/,
    );
    expect(() =>
      normalizeStoreThreadFeatureIds(names.map((_, index) => `feat-${index}`)),
    ).toThrow(/at most 12/);
  });
});

describe("buildStorePublishFeatureSnapshot", () => {
  let rootPath = "";
  let db: SqliteDatabase;
  let store: StoreModStore;

  beforeEach(() => {
    rootPath = path.join(
      os.tmpdir(),
      `stella-store-publish-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    store = new StoreModStore(db);
  });

  afterEach(async () => {
    db.close();
    await rm(rootPath, { recursive: true, force: true });
  });

  it("resolves roster features beyond the persisted snapshot window", () => {
    for (let index = 0; index < 25; index++) {
      store.upsertFeatureRosterEntry({
        featureId: `feature-${index}`,
        name: `Feature ${index}`,
        commitHash: `${index}`.padStart(40, "0"),
        committedAt: 1_000 + index,
      });
    }
    store.writeFeatureSnapshot(store.buildSnapshotFromRoster());
    expect(store.readFeatureSnapshot()?.items).toHaveLength(20);

    const snapshot = buildStorePublishFeatureSnapshot(store);
    expect(snapshot?.items).toHaveLength(25);
    const oldest = snapshot?.items.find((item) => item.name === "Feature 0");
    expect(oldest?.featureId).toBe("feature-0");
    expect(oldest?.commitHashes).toEqual(["0".padStart(40, "0")]);
  });

  it("keeps persisted-snapshot items the roster does not know about", () => {
    store.upsertFeatureRosterEntry({
      featureId: "feature-known",
      name: "Known Feature",
      commitHash: "a".repeat(40),
      committedAt: 1_000,
    });
    store.writeFeatureSnapshot({
      items: [{ name: "Legacy Feature", commitHashes: ["b".repeat(40)] }],
      generatedAt: 2_000,
    });

    const snapshot = buildStorePublishFeatureSnapshot(store);
    expect(snapshot?.items.map((item) => item.name)).toEqual([
      "Known Feature",
      "Legacy Feature",
    ]);
  });

  it("falls back to the persisted snapshot when the roster is empty", () => {
    store.writeFeatureSnapshot({
      items: [{ name: "Legacy Feature", commitHashes: ["c".repeat(40)] }],
      generatedAt: 3_000,
    });

    const snapshot = buildStorePublishFeatureSnapshot(store);
    expect(snapshot?.generatedAt).toBe(3_000);
    expect(snapshot?.items.map((item) => item.name)).toEqual([
      "Legacy Feature",
    ]);
  });
});
