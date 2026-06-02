#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PUBLIC_BASE =
  process.env.STELLA_RELEASE_PUBLIC_BASE ??
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev";
const REPO_URL =
  process.env.STELLA_GITHUB_REMOTE_URL ?? "https://github.com/ruuxi/stella";
const BASE_TAG = process.env.STELLA_SCENARIO_BASE_TAG ?? "desktop-v0.0.287";
const TARGET_TAG =
  process.env.STELLA_SCENARIO_TARGET_TAG ?? "desktop-v0.0.292";
const ROOT =
  process.env.STELLA_SCENARIO_ROOT ??
  path.join(os.tmpdir(), `stella-install-state-scenarios-${Date.now()}`);
const CACHE = path.join(ROOT, "cache");
const PLATFORM =
  process.platform === "darwin" && process.arch === "arm64"
    ? "darwin-arm64"
    : process.platform === "darwin"
      ? "darwin-x64"
      : process.platform === "win32"
        ? "win-x64"
        : "linux-x64";
const ARCHIVE_NAME =
  PLATFORM === "win-x64"
    ? "stella-desktop-win-x64.tar.zst"
    : PLATFORM === "darwin-arm64"
      ? "stella-desktop-darwin-arm64.tar.zst"
      : PLATFORM === "darwin-x64"
        ? "stella-desktop-darwin-x64.tar.zst"
        : "stella-desktop-linux-x64.tar.zst";

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

const fetchJson = async (url) => {
  const response = await fetch(url, {
    headers: { "User-Agent": "stella-install-state-scenarios" },
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
};

const sha256File = (file) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
};

const downloadFile = async (url, destination, expected) => {
  if (existsSync(destination)) {
    if (!expected?.sha256 || sha256File(destination) === expected.sha256) {
      return;
    }
    rmSync(destination, { force: true });
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "stella-install-state-scenarios" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status}: ${url}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const stream = createWriteStream(destination);
  const reader = response.body.getReader();
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (!stream.write(value)) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }
  await new Promise((resolve, reject) => {
    stream.end((error) => (error ? reject(error) : resolve()));
  });
  if (expected?.size && size !== expected.size) {
    throw new Error(`Downloaded ${size} bytes, expected ${expected.size}`);
  }
  if (expected?.sha256 && sha256File(destination) !== expected.sha256) {
    throw new Error(`Checksum mismatch for ${destination}`);
  }
};

const releaseManifestUrl = (tag) =>
  `${PUBLIC_BASE}/desktop/releases/${tag}/manifest.json`;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const headCommit = (installDir) =>
  run("git", ["rev-parse", "HEAD"], { cwd: installDir }).stdout.trim();

const isAncestor = (installDir, commit) =>
  run("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
    cwd: installDir,
    allowFailure: true,
  }).status === 0;

const trackedDirty = (installDir) =>
  run("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: installDir,
  }).stdout.trim().length > 0;

const nativeHelperSha = (installDir) => {
  const helperManifest = path.join(
    installDir,
    "desktop",
    "native",
    "out",
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux",
    ".stella-native-helpers.json",
  );
  if (!existsSync(helperManifest)) return null;
  return readJson(helperManifest).sha ?? null;
};

const writeCompleteInstallState = (installDir, args) => {
  const file = path.join(installDir, "stella-install.json");
  const manifest = readJson(file);
  const now = new Date().toISOString();
  manifest.desktopReleaseTag = args.tag;
  manifest.desktopReleaseCommit = args.commit;
  manifest.installState = {
    status: "complete",
    desktopReleaseTag: args.tag,
    desktopReleaseCommit: args.commit,
    localHeadCommit: args.localHeadCommit ?? headCommit(installDir),
    nativeHelpersSha: nativeHelperSha(installDir),
    completedAt: now,
  };
  manifest.lastUpdateAttempt = {
    status: "complete",
    targetTag: args.tag,
    targetCommit: args.commit,
    startedAt: args.startedAt ?? now,
    finishedAt: now,
    reason: null,
  };
  writeJson(file, manifest);
};

const writeAttempt = (installDir, args) => {
  const file = path.join(installDir, "stella-install.json");
  const manifest = readJson(file);
  const previous = manifest.lastUpdateAttempt;
  const now = new Date().toISOString();
  manifest.lastUpdateAttempt = {
    status: args.status,
    targetTag: args.tag,
    targetCommit: args.commit,
    startedAt:
      args.status === "updating" ? now : (previous?.startedAt ?? now),
    finishedAt: args.status === "failed" ? now : null,
    reason: args.reason ?? null,
  };
  writeJson(file, manifest);
};

const launcherWouldLaunch = (installDir) => {
  return (
    existsSync(path.join(installDir, "stella-install.json")) &&
    existsSync(path.join(installDir, "package.json")) &&
    existsSync(path.join(installDir, "desktop")) &&
    existsSync(path.join(installDir, "runtime")) &&
    existsSync(path.join(installDir, "node_modules")) &&
    existsSync(path.join(installDir, "node_modules", "electron", "dist"))
  );
};

const oldReleaseManifestGateMissing = (installDir) => {
  const manifest = readJson(path.join(installDir, "stella-release.json"));
  return Object.keys(manifest.files ?? {}).filter(
    (relative) => !existsSync(path.join(installDir, relative)),
  );
};

const installFromRelease = async (tag, name) => {
  const manifest = await fetchJson(releaseManifestUrl(tag));
  const asset = manifest.assets?.[PLATFORM];
  if (!asset) throw new Error(`No ${PLATFORM} asset in ${tag}`);
  const archive = path.join(CACHE, `${tag}-${ARCHIVE_NAME}`);
  await downloadFile(asset.url, archive, {
    sha256: asset.sha256,
    size: asset.size,
  });
  const installDir = path.join(ROOT, name);
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });
  run("tar", ["--zstd", "-xf", archive, "-C", installDir], {
    stdio: "inherit",
  });
  writeJson(path.join(installDir, "stella-install.json"), {
    version: "scenario",
    desktopReleaseTag: manifest.tag,
    desktopReleaseCommit: manifest.commit,
    platform: process.platform,
    installedAt: new Date().toISOString(),
    installPath: installDir,
    launchScript: path.join(installDir, process.platform === "win32" ? "launch.cmd" : "launch.sh"),
    shortcuts: {},
    installState: {
      status: "complete",
      desktopReleaseTag: manifest.tag,
      desktopReleaseCommit: manifest.commit,
      localHeadCommit: manifest.commit,
      nativeHelpersSha: nativeHelperSha(installDir),
      completedAt: new Date().toISOString(),
    },
    lastUpdateAttempt: null,
  });
  run("git", ["init"], { cwd: installDir });
  run("git", ["remote", "add", "origin", REPO_URL], { cwd: installDir });
  run("git", ["fetch", "--no-tags", "origin", manifest.commit], {
    cwd: installDir,
  });
  run("git", ["reset", "--mixed", "--no-refresh", manifest.commit], {
    cwd: installDir,
  });
  run("git", ["add", "-A"], { cwd: installDir });
  if (
    run("git", ["diff", "--cached", "--quiet"], {
      cwd: installDir,
      allowFailure: true,
    }).status !== 0
  ) {
    run(
      "git",
      [
        "-c",
        "user.name=Stella",
        "-c",
        "user.email=install@stella.local",
        "commit",
        "-m",
        "Stella install baseline",
      ],
      { cwd: installDir },
    );
  }
  return { installDir, manifest };
};

const cloneInstall = async (source, name) => {
  const target = path.join(ROOT, name);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => !src.includes(`${path.sep}.stella-desktop-download.tar.zst`),
  });
  return target;
};

const refreshNativeHelpers = (installDir, targetManifest) => {
  const nativeRef = targetManifest.artifacts?.find?.(
    (artifact) => artifact.kind === "native-helpers" && artifact.platform === PLATFORM,
  );
  const manifestUrl =
    nativeRef?.manifestUrl ?? `${PUBLIC_BASE}/native-helpers/current.json`;
  run(
    "bun",
    [
      path.join(installDir, "desktop", "scripts", "download-native-helpers.mjs"),
      "--manifest-url",
      manifestUrl,
      "--force",
    ],
    { cwd: installDir },
  );
};

const applyGitUpdate = (installDir, targetManifest) => {
  if (trackedDirty(installDir)) {
    throw new Error("The install tree has tracked local changes.");
  }
  run("git", ["fetch", "--no-tags", "origin", targetManifest.commit], {
    cwd: installDir,
  });
  const merge = run(
    "git",
    ["merge", "--no-edit", "-m", `Update to ${targetManifest.tag}`, targetManifest.commit],
    { cwd: installDir, allowFailure: true },
  );
  if (merge.status !== 0) {
    run("git", ["merge", "--abort"], { cwd: installDir, allowFailure: true });
    throw new Error((merge.stderr || merge.stdout || "Git merge failed.").trim());
  }
  refreshNativeHelpers(installDir, targetManifest);
  writeCompleteInstallState(installDir, {
    tag: targetManifest.tag,
    commit: targetManifest.commit,
  });
};

const findChangedTextFile = (installDir, baseCommit, targetCommit) => {
  const files = run("git", ["diff", "--name-only", baseCommit, targetCommit], {
    cwd: installDir,
  })
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /\.(ts|tsx|js|css|md|json)$/.test(file));
  if (!files.length) throw new Error("No changed text file found for conflict scenario.");
  return files[0];
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const main = async () => {
  await mkdir(CACHE, { recursive: true });
  log(`Scenario root: ${ROOT}`);
  log(`Platform: ${PLATFORM}`);
  const targetManifest = await fetchJson(releaseManifestUrl(TARGET_TAG));
  const base = await installFromRelease(BASE_TAG, "base-install");
  const targetPayload = await installFromRelease(TARGET_TAG, "target-payload");
  const targetPayloadReleaseManifest = readJson(
    path.join(targetPayload.installDir, "stella-release.json"),
  );
  assert(launcherWouldLaunch(base.installDir), "fresh install should be launchable");
  assert(
    readJson(path.join(base.installDir, "stella-install.json")).installState
      ?.status === "complete",
    "fresh install should record complete active state",
  );
  pass("fresh install from real release archive");

  const stale = await cloneInstall(base.installDir, "stale-release-manifest");
  writeJson(path.join(stale, "stella-release.json"), targetPayloadReleaseManifest);
  const partialMissingFile = Object.keys(targetPayloadReleaseManifest.files ?? {}).find(
    (file) =>
      file.startsWith("desktop/") &&
      !file.includes("package.json") &&
      existsSync(path.join(stale, file)),
  );
  if (!partialMissingFile) {
    throw new Error("Could not find a target release file to remove for partial-update scenario.");
  }
  rmSync(path.join(stale, partialMissingFile), { force: true });
  const missingUnderOldGate = oldReleaseManifestGateMissing(stale);
  assert(missingUnderOldGate.length > 0, "old file-list gate should see missing files");
  assert(launcherWouldLaunch(stale), "new launcher gate should still allow launch");
  pass("ahead-of-tree stella-release.json does not force payload reinstall");

  const clean = await cloneInstall(base.installDir, "clean-update");
  writeAttempt(clean, {
    status: "updating",
    tag: targetManifest.tag,
    commit: targetManifest.commit,
  });
  applyGitUpdate(clean, targetManifest);
  const cleanInstall = readJson(path.join(clean, "stella-install.json"));
  assert(cleanInstall.installState.status === "complete", "clean update should complete");
  assert(cleanInstall.installState.desktopReleaseCommit === targetManifest.commit, "clean update active commit should advance");
  assert(isAncestor(clean, targetManifest.commit), "target commit should be in clean update history");
  pass("clean desktop update via real git merge");

  const nativeOnly = await cloneInstall(base.installDir, "native-refresh-only");
  const beforeNative = readJson(path.join(nativeOnly, "stella-install.json"));
  refreshNativeHelpers(nativeOnly, targetManifest);
  const afterNative = readJson(path.join(nativeOnly, "stella-install.json"));
  assert(
    beforeNative.installState.desktopReleaseCommit ===
      afterNative.installState.desktopReleaseCommit,
    "native refresh should not advance desktop active commit",
  );
  pass("native helper refresh is desktop-owned and does not mutate active desktop state");

  const custom = await cloneInstall(base.installDir, "local-customization-update");
  const localFile = path.join(custom, "desktop", "src", "local-user-extension.ts");
  writeFileSync(localFile, "export const localUserExtension = true;\n");
  run("git", ["add", "desktop/src/local-user-extension.ts"], { cwd: custom });
  run(
    "git",
    [
      "-c",
      "user.name=Stella",
      "-c",
      "user.email=install@stella.local",
      "commit",
      "-m",
      "Add local user extension",
    ],
    { cwd: custom },
  );
  applyGitUpdate(custom, targetManifest);
  assert(existsSync(localFile), "local file outside official release should survive update");
  assert(isAncestor(custom, targetManifest.commit), "target should land with local customization");
  pass("desktop update preserves committed local changes outside official release files");

  const dirty = await cloneInstall(base.installDir, "dirty-failed-update");
  writeAttempt(dirty, {
    status: "updating",
    tag: targetManifest.tag,
    commit: targetManifest.commit,
  });
  writeFileSync(
    path.join(dirty, ".gitignore"),
    `${readFileSync(path.join(dirty, ".gitignore"), "utf8")}\n# dirty scenario\n`,
  );
  try {
    applyGitUpdate(dirty, targetManifest);
    throw new Error("dirty update unexpectedly succeeded");
  } catch (error) {
    writeAttempt(dirty, {
      status: "failed",
      tag: targetManifest.tag,
      commit: targetManifest.commit,
      reason: error.message,
    });
  }
  const dirtyInstall = readJson(path.join(dirty, "stella-install.json"));
  assert(dirtyInstall.installState.desktopReleaseCommit === base.manifest.commit, "failed dirty update must keep old active commit");
  assert(dirtyInstall.lastUpdateAttempt.status === "failed", "failed dirty update should be recorded");
  pass("dirty failed update keeps previous complete active state");

  const conflict = await cloneInstall(base.installDir, "conflict-failed-update");
  run("git", ["fetch", "--no-tags", "origin", targetManifest.commit], {
    cwd: conflict,
  });
  const conflictFile = findChangedTextFile(conflict, base.manifest.commit, targetManifest.commit);
  writeFileSync(path.join(conflict, conflictFile), "local conflicting content\n");
  run("git", ["add", conflictFile], { cwd: conflict });
  run(
    "git",
    [
      "-c",
      "user.name=Stella",
      "-c",
      "user.email=install@stella.local",
      "commit",
      "-m",
      "Make conflicting local edit",
    ],
    { cwd: conflict },
  );
  writeAttempt(conflict, {
    status: "updating",
    tag: targetManifest.tag,
    commit: targetManifest.commit,
  });
  try {
    applyGitUpdate(conflict, targetManifest);
    throw new Error("conflict update unexpectedly succeeded");
  } catch (error) {
    writeAttempt(conflict, {
      status: "failed",
      tag: targetManifest.tag,
      commit: targetManifest.commit,
      reason: error.message,
    });
  }
  const conflictInstall = readJson(path.join(conflict, "stella-install.json"));
  assert(conflictInstall.installState.desktopReleaseCommit === base.manifest.commit, "failed conflict update must keep old active commit");
  assert(conflictInstall.lastUpdateAttempt.status === "failed", "failed conflict update should be recorded");
  assert(!existsSync(path.join(conflict, ".git", "MERGE_HEAD")), "failed conflict update should abort merge");
  pass("merge-conflict failed update keeps previous complete active state");

  log("All install-state scenarios passed.");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
