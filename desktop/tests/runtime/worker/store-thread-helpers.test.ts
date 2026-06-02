import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStoreReleaseRedactor,
  collectStoreReleaseCommits,
  collectStoreReleaseGitArtifact,
} from "../../../../runtime/worker/store-thread-helpers.js";

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
