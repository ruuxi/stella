import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorktreeMutationSnapshot,
  diffWorktreeMutationSnapshots,
  restoreSnapshotHeadForSelfMod,
} from "../../../../../runtime/kernel/integrations/worktree-mutation-scope.js";

const tempDirs: string[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepo = (): string => {
  const created = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-worktree-mutation-"),
  );
  tempDirs.push(created);
  const repo = fs.realpathSync(created);
  git(repo, "init");
  git(repo, "config", "user.email", "stella-tests@example.com");
  git(repo, "config", "user.name", "Stella Tests");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  fs.writeFileSync(path.join(repo, "delete me.txt"), "delete\n");
  fs.writeFileSync(path.join(repo, "rename -> me.txt"), "rename\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "baseline");
  return repo;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree mutation scope", () => {
  it("captures native add, update, delete, and rename mutations under an explicit repo root", async () => {
    const repo = createRepo();
    const before = await captureWorktreeMutationSnapshot(repo);

    fs.writeFileSync(path.join(repo, "tracked.txt"), "updated\n");
    fs.writeFileSync(path.join(repo, "new file.txt"), "new\n");
    fs.unlinkSync(path.join(repo, "delete me.txt"));
    git(repo, "mv", "rename -> me.txt", "renamed file.txt");

    const after = await captureWorktreeMutationSnapshot(repo);
    const diff = diffWorktreeMutationSnapshots(before, after);
    expect(diff.headChanged).toBe(false);
    expect(diff.fileChanges).toEqual(
      expect.arrayContaining([
        { path: path.join(repo, "tracked.txt"), kind: { type: "update" } },
        { path: path.join(repo, "new file.txt"), kind: { type: "add" } },
        { path: path.join(repo, "delete me.txt"), kind: { type: "delete" } },
        {
          path: path.join(repo, "rename -> me.txt"),
          kind: {
            type: "update",
            move_path: path.join(repo, "renamed file.txt"),
          },
        },
      ]),
    );
  });

  it("excludes untouched pre-existing WIP but attributes a changed dirty file", async () => {
    const repo = createRepo();
    const untouched = path.join(repo, "tracked.txt");
    const changedAgain = path.join(repo, "delete me.txt");
    fs.writeFileSync(untouched, "user wip\n");
    fs.writeFileSync(changedAgain, "first dirty state\n");
    const before = await captureWorktreeMutationSnapshot(repo);

    fs.writeFileSync(changedAgain, "agent changed dirty state\n");
    const after = await captureWorktreeMutationSnapshot(repo);
    const changedPaths = diffWorktreeMutationSnapshots(
      before,
      after,
    ).fileChanges.map((change) => change.path);

    expect(changedPaths).toContain(changedAgain);
    expect(changedPaths).not.toContain(untouched);
  });

  it("detects a native HEAD move even when the worker leaves a clean tree", async () => {
    const repo = createRepo();
    const before = await captureWorktreeMutationSnapshot(repo);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "committed natively\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "native commit");
    const after = await captureWorktreeMutationSnapshot(repo);

    const diff = diffWorktreeMutationSnapshots(before, after);
    expect(diff.headChanged).toBe(true);
    expect(diff.beforeHead).not.toBe(diff.afterHead);
  });

  it("adopts a native commit back into reversible worktree changes", async () => {
    const repo = createRepo();
    const before = await captureWorktreeMutationSnapshot(repo);
    const baselineHead = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "committed natively\n");
    fs.writeFileSync(path.join(repo, "native-created.txt"), "created\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "native commit");

    await expect(restoreSnapshotHeadForSelfMod(before)).resolves.toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(baselineHead);
    const after = await captureWorktreeMutationSnapshot(repo);
    expect(diffWorktreeMutationSnapshots(before, after).fileChanges).toEqual(
      expect.arrayContaining([
        { path: path.join(repo, "tracked.txt"), kind: { type: "update" } },
        {
          path: path.join(repo, "native-created.txt"),
          kind: { type: "add" },
        },
      ]),
    );
  });

  it("refuses to rewrite a different branch while adopting native commits", async () => {
    const repo = createRepo();
    const before = await captureWorktreeMutationSnapshot(repo);
    git(repo, "checkout", "-b", "native-branch");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "other branch\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "other branch commit");

    await expect(restoreSnapshotHeadForSelfMod(before)).rejects.toThrow(
      "changed the checked-out Git branch",
    );
    expect(git(repo, "branch", "--show-current")).toBe("native-branch");
  });
});
