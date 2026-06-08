#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT =
  process.env.STELLA_UPDATE_TRANSACTION_SCENARIO_ROOT ??
  path.join(os.tmpdir(), `stella-update-transaction-scenarios-${Date.now()}`);

const log = (message) => process.stdout.write(`${message}\n`);
const pass = (name) => log(`PASS ${name}`);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

const git = (cwd, args, options = {}) => run("git", args, { ...options, cwd });

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const read = (file) => readFileSync(file, "utf8");
const write = (file, content) => writeFileSync(file, content, "utf8");
const headCommit = (repo) => git(repo, ["rev-parse", "HEAD"]).stdout.trim();

const isAncestor = (repo, commit) =>
  git(repo, ["merge-base", "--is-ancestor", commit, "HEAD"], {
    allowFailure: true,
  }).status === 0;

const trackedDirtyFiles = (repo) =>
  git(repo, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "--untracked-files=no",
  ])
    .stdout.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const pathPart = line.slice(3).trim();
      const renameMarker = pathPart.lastIndexOf(" -> ");
      return renameMarker >= 0
        ? pathPart.slice(renameMarker + 4)
        : pathPart;
    });

const repoPathOverlaps = (left, right) => {
  const a = left.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const b = right.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return Boolean(a && b) && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
};

const writeCompleteInstallState = (repo, args) => {
  write(
    path.join(repo, "stella-install.json"),
    `${JSON.stringify(
      {
        version: "scenario",
        platform: process.platform,
        installPath: repo,
        installedAt: new Date(0).toISOString(),
        desktopReleaseTag: args.tag,
        desktopReleaseCommit: args.commit,
        desktopInstallBaseCommit: args.baseCommit ?? args.commit,
        installState: {
          status: "complete",
          desktopReleaseTag: args.tag,
          desktopReleaseCommit: args.commit,
          localHeadCommit: headCommit(repo),
          nativeHelpersSha: null,
          completedAt: new Date().toISOString(),
        },
        lastUpdateAttempt: {
          status: "complete",
          targetTag: args.tag,
          targetCommit: args.commit,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          reason: null,
          operationId: args.operationId ?? null,
          phase: "record-complete",
          mode: "git",
          recoveryAction: "resume",
          startingHeadCommit: args.startingHeadCommit ?? null,
          updatedAt: new Date().toISOString(),
          changedFiles: args.changedFiles ?? [],
          ownedTempPaths: [],
          nativeHelpersManifestUrl: null,
        },
      },
      null,
      2,
    )}\n`,
  );
};

const applyUpdateLikeDesktop = (repo, targetCommit, tag) => {
  const startingHeadCommit = headCommit(repo);
  if (existsSync(path.join(repo, ".git", "MERGE_HEAD"))) {
    return {
      status: "needs-agent",
      reason: "merge-in-progress",
      startingHeadCommit,
    };
  }

  git(repo, ["fetch", "--no-tags", "origin", targetCommit]);
  const alreadyApplied = git(
    repo,
    ["merge-base", "--is-ancestor", targetCommit, "HEAD"],
    { allowFailure: true },
  );
  if (alreadyApplied.status === 0) {
    writeCompleteInstallState(repo, {
      tag,
      commit: targetCommit,
      startingHeadCommit,
      changedFiles: [],
    });
    return { status: "applied", changedFiles: [], startingHeadCommit };
  }

  const mergeTree = git(repo, ["merge-tree", "--write-tree", "HEAD", targetCommit], {
    allowFailure: true,
  });
  if (mergeTree.status !== 0) {
    return {
      status: "needs-agent",
      reason: "merge-tree-conflict",
      startingHeadCommit,
    };
  }
  const treeOid = mergeTree.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f]{40,64}$/i.test(line));
  assert(treeOid, "merge-tree should produce a tree oid");

  const changedFiles = git(repo, ["diff", "--name-only", "HEAD", treeOid])
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dirtyFiles = trackedDirtyFiles(repo);
  const overlappingDirty = dirtyFiles.filter((dirty) =>
    changedFiles.some((changed) => repoPathOverlaps(dirty, changed)),
  );
  if (overlappingDirty.length > 0) {
    return {
      status: "needs-agent",
      reason: "tracked-local-changes-overlap",
      startingHeadCommit,
      changedFiles,
      overlappingDirty,
    };
  }

  const merge = git(
    repo,
    ["merge", "--no-edit", "-m", `Update to ${tag}`, targetCommit],
    { allowFailure: true },
  );
  if (merge.status !== 0) {
    git(repo, ["merge", "--abort"], { allowFailure: true });
    return {
      status: "needs-agent",
      reason: "merge-failed",
      startingHeadCommit,
      changedFiles,
    };
  }
  writeCompleteInstallState(repo, {
    tag,
    commit: targetCommit,
    baseCommit: startingHeadCommit,
    startingHeadCommit,
    changedFiles,
  });
  return { status: "applied", changedFiles, startingHeadCommit };
};

const createReleaseRepo = async () => {
  const origin = path.join(ROOT, "origin.git");
  const author = path.join(ROOT, "author");
  await mkdir(ROOT, { recursive: true });
  git(ROOT, ["init", "--bare", origin]);
  git(ROOT, ["clone", origin, author]);
  git(author, ["config", "user.email", "release@stella.local"]);
  git(author, ["config", "user.name", "Stella Release"]);
  git(author, ["config", "commit.gpgsign", "false"]);

  write(path.join(author, "app.txt"), "title: Stella\nbody: base\n");
  write(path.join(author, "user-settings.json"), "{\n  \"theme\": \"light\"\n}\n");
  git(author, ["add", "."]);
  git(author, ["commit", "-m", "desktop-v1"]);
  const base = headCommit(author);

  write(path.join(author, "app.txt"), "title: Stella\nbody: update one\n");
  git(author, ["commit", "-am", "desktop-v2"]);
  const updateOne = headCommit(author);

  write(path.join(author, "app.txt"), "title: Stella\nbody: update two\n");
  git(author, ["commit", "-am", "desktop-v3"]);
  const updateTwo = headCommit(author);

  git(author, ["push", "origin", "HEAD:main"]);
  return { origin, base, updateOne, updateTwo };
};

const installAt = async (origin, commit, name) => {
  const repo = path.join(ROOT, name);
  git(ROOT, ["clone", origin, repo]);
  git(repo, ["config", "user.email", "install@stella.local"]);
  git(repo, ["config", "user.name", "Stella Install"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["reset", "--hard", commit]);
  writeCompleteInstallState(repo, {
    tag: "desktop-v-installed",
    commit,
  });
  return repo;
};

const main = async () => {
  log(`Scenario root: ${ROOT}`);
  const release = await createReleaseRepo();

  const oneBehind = await installAt(release.origin, release.updateOne, "one-behind");
  const oneBehindResult = applyUpdateLikeDesktop(
    oneBehind,
    release.updateTwo,
    "desktop-v3",
  );
  assert(oneBehindResult.status === "applied", "one-behind update should apply");
  assert(isAncestor(oneBehind, release.updateTwo), "one-behind install should contain target");
  pass("one update behind applies through normal desktop merge");

  const coupleBehind = await installAt(release.origin, release.base, "couple-behind");
  const coupleBehindResult = applyUpdateLikeDesktop(
    coupleBehind,
    release.updateTwo,
    "desktop-v3",
  );
  assert(coupleBehindResult.status === "applied", "couple-behind update should apply");
  assert(isAncestor(coupleBehind, release.updateTwo), "couple-behind install should contain target");
  pass("multiple updates behind applies to latest target");

  const dirtyNonConflict = await installAt(
    release.origin,
    release.updateOne,
    "dirty-non-conflict",
  );
  write(
    path.join(dirtyNonConflict, "user-settings.json"),
    "{\n  \"theme\": \"dark\"\n}\n",
  );
  const dirtyNonConflictResult = applyUpdateLikeDesktop(
    dirtyNonConflict,
    release.updateTwo,
    "desktop-v3",
  );
  assert(
    dirtyNonConflictResult.status === "applied",
    "dirty non-conflicting update should apply",
  );
  assert(
    read(path.join(dirtyNonConflict, "user-settings.json")).includes("dark"),
    "non-conflicting dirty edit should survive",
  );
  assert(
    trackedDirtyFiles(dirtyNonConflict).includes("user-settings.json"),
    "non-conflicting dirty edit should remain dirty",
  );
  pass("dirty non-conflicting tracked edits are preserved while update applies");

  const dirtyConflict = await installAt(
    release.origin,
    release.updateOne,
    "dirty-conflict",
  );
  write(path.join(dirtyConflict, "app.txt"), "title: Stella\nbody: local dirty\n");
  const dirtyConflictResult = applyUpdateLikeDesktop(
    dirtyConflict,
    release.updateTwo,
    "desktop-v3",
  );
  assert(
    dirtyConflictResult.status === "needs-agent",
    "dirty conflicting update should need agent",
  );
  assert(
    dirtyConflictResult.reason === "tracked-local-changes-overlap",
    "dirty conflict should be detected before merge",
  );
  assert(
    !isAncestor(dirtyConflict, release.updateTwo),
    "dirty conflicting install should not advance",
  );
  pass("dirty conflicting tracked edits are blocked before merge");

  const committedNonConflict = await installAt(
    release.origin,
    release.updateOne,
    "committed-non-conflict",
  );
  write(
    path.join(committedNonConflict, "user-settings.json"),
    "{\n  \"theme\": \"solarized\"\n}\n",
  );
  git(committedNonConflict, ["commit", "-am", "Local settings change"]);
  const committedNonConflictResult = applyUpdateLikeDesktop(
    committedNonConflict,
    release.updateTwo,
    "desktop-v3",
  );
  assert(
    committedNonConflictResult.status === "applied",
    "non-conflicting local commit should merge",
  );
  assert(
    read(path.join(committedNonConflict, "user-settings.json")).includes(
      "solarized",
    ),
    "non-conflicting local commit should survive",
  );
  pass("non-conflicting local commits merge with desktop update");

  const committedConflict = await installAt(
    release.origin,
    release.updateOne,
    "committed-conflict",
  );
  write(
    path.join(committedConflict, "app.txt"),
    "title: Stella\nbody: local committed\n",
  );
  git(committedConflict, ["commit", "-am", "Local conflicting app change"]);
  const committedConflictResult = applyUpdateLikeDesktop(
    committedConflict,
    release.updateTwo,
    "desktop-v3",
  );
  assert(
    committedConflictResult.status === "needs-agent",
    "conflicting local commit should need agent",
  );
  assert(
    committedConflictResult.reason === "merge-tree-conflict",
    "committed conflict should be detected by merge-tree",
  );
  assert(
    !existsSync(path.join(committedConflict, ".git", "MERGE_HEAD")),
    "preflight conflict should not leave a merge in progress",
  );
  pass("conflicting local commits are routed to agent without dirtying merge state");

  log("All update transaction scenarios passed.");
};

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
