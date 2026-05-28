/**
 * IPC for desktop update tracking and the clean-merge fast path.
 *
 * The launcher writes `stella-install.json` to the install directory after
 * setup. We surface two read/write helpers here:
 *
 *   - `updates:getInstallManifest` — return the parsed manifest so the
 *     renderer can compare its `desktopReleaseCommit` against the
 *     reactive `currentDesktopRelease` Convex query.
 *   - `updates:tryApplyCleanUpdate` — fetch and preflight a Git merge
 *     without touching the working tree; if Git reports no conflicts,
 *     bracket the merge with the runtime self-mod HMR lifecycle so the
 *     renderer morphs after the update. Conflict/dirty cases return a
 *     fallback signal for the install-update agent.
 *   - `updates:recordAppliedCommit` — verify against the local git tree
 *     that the install-update agent actually landed the target commit,
 *     then overwrite the manifest's `desktopReleaseCommit`. The agent's
 *     self-reported "completed" outcome is not trusted: git's
 *     `merge-base --is-ancestor` plus the absence of an in-progress
 *     `.git/MERGE_HEAD` is. The local "start" commit
 *     (`desktopInstallBaseCommit`) is left untouched.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setupEnvironment } from "dugite";
import {
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
  IPC_UPDATES_RECORD_SOURCE_HISTORY,
  IPC_UPDATES_REFRESH_NATIVE_HELPERS,
  IPC_UPDATES_TRY_APPLY_CLEAN,
} from "../../src/shared/contracts/ipc-channels.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type {
  DesktopReleaseSourceHistoryRef,
  DesktopReleaseSourcePackRef,
  StellaReleaseArtifactRef,
  StoreReleaseSourcePack,
} from "../../../runtime/contracts/index.js";
import {
  applyStellaSourcePack,
  type StellaSourceApplyResult,
  type StellaSourceApplyConflict,
  type StellaSourceBlob,
} from "../../../runtime/kernel/self-mod/stella-source-control.js";
import {
  collectSourcePackPaths,
  findStoreSourcePackApplyObstruction,
  readLocalSourceTree,
  writeSourcePackApplyResult,
} from "../../../runtime/worker/store-source-pack-install.js";
import {
  desktopSourcePackCanApplyLocally,
  desktopSourcePackMatchesBaseCommit,
  desktopReleaseManifestUrl,
  recordDesktopUpdateSourceHistory,
  sourceHistoryRefFromDesktopReleaseManifest,
} from "./desktop-source-history.js";

const INSTALL_MANIFEST_BASENAME = "stella-install.json";
const DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers";
const DEFAULT_NATIVE_HELPERS_MANIFEST_URL = `${DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL}/current.json`;

const nativeHelperPlatformKey = (): string => {
  if (process.platform === "win32" && process.arch === "x64") {
    return "win-x64";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "darwin-x64";
  }
  return "";
};

export type InstallManifestSnapshot = {
  version: string;
  platform: string;
  installPath: string;
  installedAt: string;
  desktopReleaseTag: string | null;
  desktopReleaseCommit: string | null;
  desktopInstallBaseCommit: string | null;
};

export type UpdatesHandlersOptions = {
  getStellaRoot: () => string | null;
  getStellaHome: () => string | null;
  getStellaHostRunner?: () => StellaHostRunner | null;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const manifestPathFromRoot = (stellaRoot: string): string =>
  path.join(stellaRoot, INSTALL_MANIFEST_BASENAME);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const requireString = (value: unknown, field: string): string => {
  const v = asString(value);
  if (!v) {
    throw new Error(`Install manifest field ${field} is missing or empty.`);
  }
  return v;
};

type GitRunResult = { exitCode: number; stdout: string; stderr: string };
type ProcessRunResult = { exitCode: number; stdout: string; stderr: string };

const runGit = (cwd: string, args: string[]): Promise<GitRunResult> =>
  new Promise((resolve, reject) => {
    const { env, gitLocation } = setupEnvironment({});
    const child = spawn(gitLocation, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

const runProcess = (
  cwd: string,
  command: string,
  args: string[],
): Promise<ProcessRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

const candidateBunCommands = (): string[] => {
  const seen = new Set<string>();
  const add = (candidate: string | null | undefined) => {
    const value = candidate?.trim();
    if (value) seen.add(value);
  };
  add(process.env.STELLA_BUN_PATH);
  add(process.env.BUN_PATH);
  add("bun");
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    add(
      path.join(
        homeDir,
        ".bun",
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      ),
    );
  }
  return [...seen];
};

const getNativeHelpersManifestUrl = (): string => {
  const explicit = process.env.STELLA_NATIVE_HELPERS_MANIFEST_URL?.trim();
  if (explicit) return explicit;
  const baseUrl = (
    process.env.STELLA_NATIVE_HELPERS_BASE_URL ??
    DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL
  ).replace(/\/+$/, "");
  return baseUrl === DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL
    ? DEFAULT_NATIVE_HELPERS_MANIFEST_URL
    : `${baseUrl}/current.json`;
};

const refreshNativeHelpers = async (
  stellaRoot: string,
  _releaseTag?: string,
  artifactRefs?: StellaReleaseArtifactRef[],
): Promise<{ manifestUrl: string; stdout: string; stderr: string }> => {
  const platformKey = nativeHelperPlatformKey();
  const releaseNativeRef = artifactRefs?.find(
    (ref) => ref.kind === "native-helpers" && ref.platform === platformKey,
  );
  const manifestUrl =
    releaseNativeRef?.manifestUrl ?? getNativeHelpersManifestUrl();
  const scriptPath = path.join(
    stellaRoot,
    "desktop",
    "scripts",
    "download-native-helpers.mjs",
  );
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(
      "Native helper download script is missing from this install.",
    );
  }

  let lastMissingBunError: Error | null = null;
  for (const bunCommand of candidateBunCommands()) {
    let result: ProcessRunResult;
    try {
      result = await runProcess(stellaRoot, bunCommand, [
        scriptPath,
        "--manifest-url",
        manifestUrl,
        "--force",
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastMissingBunError = error as Error;
        continue;
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        detail
          ? `Native helper refresh failed: ${detail}`
          : `Native helper refresh failed with exit code ${result.exitCode}.`,
      );
    }
    return { manifestUrl, stdout: result.stdout, stderr: result.stderr };
  }
  throw new Error(
    lastMissingBunError
      ? "Native helper refresh failed because Bun is not available."
      : "Native helper refresh failed because no Bun command was configured.",
  );
};

const readGitFile = async (
  cwd: string,
  revisionPath: string,
): Promise<string | null> => {
  const result = await runGit(cwd, ["show", revisionPath]);
  return result.exitCode === 0 ? result.stdout : null;
};

type VerifyResult =
  | { ok: true; headCommit: string }
  | { ok: false; reason: string };

type DesktopUpdateFastApplyResult =
  | {
      status: "applied";
      manifest: InstallManifestSnapshot | null;
      headCommit: string;
      changedFiles: string[];
      dependencyInstallRan: boolean;
      nativeHelpersRefreshed: boolean;
    }
  | {
      status: "needs-agent";
      reason: string;
      headCommit?: string;
      changedFiles?: string[];
      sourcePackFile?: string;
      sourcePackConflictFile?: string;
      sourcePackConflictJson?: string;
    };

const MAX_DESKTOP_SOURCE_PACK_BYTES = 10 * 1024 * 1024;
const MAX_DESKTOP_SOURCE_HISTORY_BYTES = 10 * 1024 * 1024;
const MAX_DESKTOP_SOURCE_PACK_CONFLICT_PROMPT_BYTES = 200 * 1024;

const DEPENDENCY_FILE_NAMES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
]);

const parseGitNameList = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const gitFailureDetail = (result: GitRunResult, fallback: string): string => {
  const detail = (result.stderr || result.stdout).trim();
  return detail || fallback;
};

const isDependencyChange = (filePath: string): boolean =>
  DEPENDENCY_FILE_NAMES.has(path.basename(filePath));

const readHeadCommit = async (stellaRoot: string): Promise<string> => {
  const result = await runGit(stellaRoot, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(gitFailureDetail(result, "Could not read current HEAD."));
  }
  return result.stdout.trim();
};

const hasMergeInProgress = async (stellaRoot: string): Promise<boolean> => {
  try {
    await fs.access(path.join(stellaRoot, ".git", "MERGE_HEAD"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};

const hasTrackedWorkingTreeChanges = async (
  stellaRoot: string,
): Promise<boolean> => {
  const status = await runGit(stellaRoot, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (status.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(status, "Could not inspect install tree status."),
    );
  }
  return status.stdout.trim().length > 0;
};

const abortMergeIfNeeded = async (stellaRoot: string) => {
  if (!(await hasMergeInProgress(stellaRoot))) return;
  await runGit(stellaRoot, ["merge", "--abort"]).catch(() => undefined);
};

const writeAppliedCommit = async (
  stellaRoot: string,
  commit: string,
  tag: string | null,
): Promise<InstallManifestSnapshot | null> => {
  const verification = await verifyMergeApplied(stellaRoot, commit);
  if (!verification.ok) {
    throw new Error(verification.reason);
  }
  const manifestPath = manifestPathFromRoot(stellaRoot);
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    parseManifest(raw);
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const recovered = await readManifestWithRecovery(stellaRoot);
    if (recovered) {
      parsed = {
        version: recovered.version,
        platform: recovered.platform,
        installPath: recovered.installPath,
        installedAt: recovered.installedAt,
        desktopReleaseTag: recovered.desktopReleaseTag,
        desktopReleaseCommit: recovered.desktopReleaseCommit,
        desktopInstallBaseCommit: recovered.desktopInstallBaseCommit,
      };
    }
  }
  if (!parsed) {
    throw new Error("Install manifest is unavailable.");
  }
  parsed.desktopReleaseCommit = commit;
  // Tag flows in from the Convex publish payload (`currentRelease.tag`),
  // not derived locally — that way skipping releases (e.g. user goes
  // 0.0.133 → 0.0.135) records the correct tag, not an auto-increment.
  // `version` is intentionally left alone: it's set by the launcher to
  // its own CARGO_PKG_VERSION at install time and represents the
  // launcher binary's identity, not the desktop release.
  if (tag) {
    parsed.desktopReleaseTag = tag;
  }
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  parseManifest(next);
  await writeFileAtomic(manifestPath, next);
  return parseManifest(next);
};

const writeAppliedReleasePointer = async (
  stellaRoot: string,
  commit: string,
  tag: string | null,
): Promise<InstallManifestSnapshot | null> => {
  const manifestPath = manifestPathFromRoot(stellaRoot);
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    parseManifest(raw);
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const recovered = await readManifestWithRecovery(stellaRoot);
    if (recovered) {
      parsed = {
        version: recovered.version,
        platform: recovered.platform,
        installPath: recovered.installPath,
        installedAt: recovered.installedAt,
        desktopReleaseTag: recovered.desktopReleaseTag,
        desktopReleaseCommit: recovered.desktopReleaseCommit,
        desktopInstallBaseCommit: recovered.desktopInstallBaseCommit,
      };
    }
  }
  if (!parsed) {
    throw new Error("Install manifest is unavailable.");
  }
  parsed.desktopReleaseCommit = commit;
  if (tag) {
    parsed.desktopReleaseTag = tag;
  }
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  parseManifest(next);
  await writeFileAtomic(manifestPath, next);
  return parseManifest(next);
};

/**
 * Confirm the install-update agent actually landed `targetCommit` into the
 * install's git history. The two checks together are the contract:
 *
 *  1. `.git/MERGE_HEAD` does not exist — no half-finished merge sitting in
 *     the working tree (would mean the agent aborted mid-merge).
 *  2. `git merge-base --is-ancestor <target> HEAD` exits 0 — the target
 *     SHA is in HEAD's ancestry, i.e. a real merge commit was created
 *     (or HEAD was fast-forwarded to/past target).
 *
 * Per the install-update agent's merge bias, it is *allowed* to skip or
 * adapt upstream changes when they don't fit the user's customized tree.
 * So we deliberately do not require the working tree to literally contain
 * every upstream line — only that the merge process completed and HEAD is
 * caught up with target.
 */
const verifyMergeApplied = async (
  stellaRoot: string,
  targetCommit: string,
): Promise<VerifyResult> => {
  const gitDir = await runGit(stellaRoot, ["rev-parse", "--git-dir"]);
  if (gitDir.exitCode !== 0) {
    return {
      ok: false,
      reason: "Install directory is not a git repository.",
    };
  }
  try {
    await fs.access(path.join(stellaRoot, ".git", "MERGE_HEAD"));
    return {
      ok: false,
      reason:
        "A merge is still in progress in the install tree — Stella didn't finish applying the update.",
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        reason: `Could not inspect .git/MERGE_HEAD: ${(err as Error).message}`,
      };
    }
  }
  const isAncestor = await runGit(stellaRoot, [
    "merge-base",
    "--is-ancestor",
    targetCommit,
    "HEAD",
  ]);
  if (isAncestor.exitCode !== 0) {
    return {
      ok: false,
      reason: `HEAD does not contain target commit ${targetCommit.slice(0, 8)} — the merge didn't land.`,
    };
  }
  const headRev = await runGit(stellaRoot, ["rev-parse", "HEAD"]);
  if (headRev.exitCode !== 0) {
    return {
      ok: false,
      reason: "Could not read current HEAD after the update.",
    };
  }
  return { ok: true, headCommit: headRev.stdout.trim() };
};

const parseManifest = (raw: string): InstallManifestSnapshot => {
  if (!raw.trim()) {
    throw new Error("Install manifest is empty.");
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    version: requireString(parsed.version, "version"),
    platform: requireString(parsed.platform, "platform"),
    installPath: requireString(parsed.installPath, "installPath"),
    installedAt: requireString(parsed.installedAt, "installedAt"),
    desktopReleaseTag: asString(parsed.desktopReleaseTag),
    desktopReleaseCommit: asString(parsed.desktopReleaseCommit),
    desktopInstallBaseCommit: asString(parsed.desktopInstallBaseCommit),
  };
};

const tryParseManifest = (
  raw: string,
  source: string,
): InstallManifestSnapshot | null => {
  try {
    return parseManifest(raw);
  } catch (error) {
    console.warn(
      `[updates] Ignoring invalid install manifest from ${source}:`,
      (error as Error).message,
    );
    return null;
  }
};

const readReleaseManifest = async (
  stellaRoot: string,
): Promise<{ tag: string | null; commit: string | null }> => {
  try {
    const raw = await fs.readFile(
      path.join(stellaRoot, "stella-release.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      tag: asString(parsed.tag),
      commit: asString(parsed.commit),
    };
  } catch {
    return { tag: null, commit: null };
  }
};

const recoverManifest = async (
  stellaRoot: string,
): Promise<InstallManifestSnapshot | null> => {
  const tracked = await readGitFile(
    stellaRoot,
    `HEAD:${INSTALL_MANIFEST_BASENAME}`,
  );
  if (tracked) {
    const parsed = tryParseManifest(tracked, "git HEAD");
    if (parsed) return parsed;
  }

  const release = await readReleaseManifest(stellaRoot);
  const head = await runGit(stellaRoot, ["rev-parse", "HEAD"]);
  return {
    version: "recovered",
    platform: process.platform,
    installPath: stellaRoot,
    installedAt: new Date().toISOString(),
    desktopReleaseTag: release.tag,
    desktopReleaseCommit:
      release.commit ?? (head.exitCode === 0 ? head.stdout.trim() : null),
    desktopInstallBaseCommit: null,
  };
};

const readManifestWithRecovery = async (
  stellaRoot: string,
): Promise<InstallManifestSnapshot | null> => {
  const manifestPath = manifestPathFromRoot(stellaRoot);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const parsed = tryParseManifest(raw, manifestPath);
    if (parsed) return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(
      "[updates] Failed to read install manifest:",
      (err as Error).message,
    );
  }
  return await recoverManifest(stellaRoot);
};

const hashBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const fetchDesktopSourcePackRef = async (
  ref: DesktopReleaseSourcePackRef | DesktopReleaseSourceHistoryRef,
  args: { label: string; maxBytes: number },
): Promise<StoreReleaseSourcePack> => {
  if (ref.kind !== "url" || !/^https:\/\//i.test(ref.url)) {
    throw new Error(`${args.label} reference is invalid.`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(ref.sha256)) {
    throw new Error(`${args.label} hash is invalid.`);
  }
  if (
    !Number.isInteger(ref.sizeBytes) ||
    ref.sizeBytes <= 0 ||
    ref.sizeBytes > args.maxBytes
  ) {
    throw new Error(`${args.label} size is invalid.`);
  }
  const response = await fetch(ref.url);
  if (!response.ok) {
    throw new Error(`${args.label} download failed (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.sizeBytes) {
    throw new Error(`${args.label} size did not match the release.`);
  }
  if (hashBytes(bytes).toLowerCase() !== ref.sha256.toLowerCase()) {
    throw new Error(`${args.label} hash did not match the release.`);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as StoreReleaseSourcePack;
};

const fetchDesktopUpdateSourcePack = async (
  ref: DesktopReleaseSourcePackRef,
): Promise<StoreReleaseSourcePack> =>
  fetchDesktopSourcePackRef(ref, {
    label: "Desktop source pack",
    maxBytes: MAX_DESKTOP_SOURCE_PACK_BYTES,
  });

const sourcePackEmbedsContent = (pack: StoreReleaseSourcePack): boolean =>
  pack.changeSets.some((changeSet) =>
    changeSet.changes.some((change) => "base" in change || "next" in change),
  );

const fetchDesktopSourceHistoryPack = async (
  ref: DesktopReleaseSourceHistoryRef,
): Promise<StoreReleaseSourcePack> => {
  const pack = await fetchDesktopSourcePackRef(ref, {
    label: "Desktop source history",
    maxBytes: MAX_DESKTOP_SOURCE_HISTORY_BYTES,
  });
  if (sourcePackEmbedsContent(pack)) {
    throw new Error("Desktop source history must not include source content.");
  }
  return pack;
};

const fetchDesktopReleaseSourceHistoryRef = async (args: {
  releaseTag: string;
  targetCommit: string;
}): Promise<DesktopReleaseSourceHistoryRef | null> => {
  const url = desktopReleaseManifestUrl(args.releaseTag);
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const manifest = (await response.json()) as unknown;
  return sourceHistoryRefFromDesktopReleaseManifest(manifest, {
    targetCommit: args.targetCommit,
  });
};

const writeFileAtomic = async (filePath: string, content: string) => {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

type SourcePackAppliedChangeForAgent = {
  path: string;
  content: StellaSourceBlob | null;
};

const buildSourcePackAppliedChangesForAgent = (
  sourceApply: StellaSourceApplyResult,
): SourcePackAppliedChangeForAgent[] =>
  sourceApply.appliedPaths.map((filePath) => ({
    path: filePath,
    content: sourceApply.tree[filePath] ?? null,
  }));

const tryApplySourcePackDesktopUpdate = async (
  stellaRoot: string,
  stellaHome: string,
  runner: StellaHostRunner | null,
  args: {
    baseCommit: string;
    targetCommit: string;
    releaseTag: string;
    sourcePackRef: DesktopReleaseSourcePackRef;
    artifactRefs?: StellaReleaseArtifactRef[];
  },
): Promise<DesktopUpdateFastApplyResult> => {
  if (await hasMergeInProgress(stellaRoot)) {
    return {
      status: "needs-agent",
      reason: "A merge is already in progress in the install tree.",
    };
  }

  if (await hasTrackedWorkingTreeChanges(stellaRoot)) {
    return {
      status: "needs-agent",
      reason: "The install tree has tracked local changes.",
    };
  }

  const sourcePack = await fetchDesktopUpdateSourcePack(args.sourcePackRef);
  if (!desktopSourcePackMatchesBaseCommit(sourcePack, args.baseCommit)) {
    return {
      status: "needs-agent",
      reason: `Desktop source pack starts at ${sourcePack.baseRevisionId}, but this install is based on git:${args.baseCommit}.`,
      changedFiles: [],
    };
  }
  const sourcePaths = collectSourcePackPaths(sourcePack);
  if (!desktopSourcePackCanApplyLocally(sourcePack)) {
    return {
      status: "needs-agent",
      reason:
        "Desktop source pack omits content needed for local apply; falling back to Git update.",
      changedFiles: sourcePaths,
    };
  }
  const obstruction = await findStoreSourcePackApplyObstruction({
    repoRoot: stellaRoot,
    paths: sourcePaths,
    isPathTracked: async (sourcePath) => {
      const result = await runGit(stellaRoot, [
        "ls-files",
        "--error-unmatch",
        "--",
        sourcePath,
      ]);
      return result.exitCode === 0;
    },
  });
  if (obstruction) {
    return {
      status: "needs-agent",
      reason: `${obstruction.reason} Falling back to Git update.`,
      changedFiles: sourcePaths,
    };
  }
  const recordSourceHistory = async (commitHash = args.targetCommit) => {
    if (!runner) return;
    await recordDesktopUpdateSourceHistory(runner, {
      sourcePack,
      releaseTag: args.releaseTag,
      targetCommit: commitHash,
    }).catch((error) => {
      console.warn("[updates] Failed to record desktop source history:", error);
    });
  };
  const localTree = await readLocalSourceTree(stellaRoot, sourcePaths);
  const sourceApply = applyStellaSourcePack({
    pack: sourcePack,
    localTree,
  });

  if (sourceApply.status === "conflicts") {
    const conflictRoot = path.join(
      stellaHome,
      "raw",
      "desktop-updates",
      args.releaseTag.replace(/[^a-z0-9_.-]/gi, "_"),
    );
    const sourcePackFile = path.join(conflictRoot, "SOURCE_PACK.json");
    const conflictFile = path.join(conflictRoot, "SOURCE_PACK_CONFLICTS.json");
    const conflictPayload = {
      status: sourceApply.status,
      revisionId: sourceApply.revisionId,
      sourcePackFile,
      appliedPaths: sourceApply.appliedPaths,
      appliedChanges: buildSourcePackAppliedChangesForAgent(sourceApply),
      noopPaths: sourceApply.noopPaths,
      conflicts: sourceApply.conflicts satisfies StellaSourceApplyConflict[],
    };
    const sourcePackConflictJson = `${JSON.stringify(conflictPayload, null, 2)}\n`;
    const shouldInlineConflictJson =
      new TextEncoder().encode(sourcePackConflictJson).byteLength <=
      MAX_DESKTOP_SOURCE_PACK_CONFLICT_PROMPT_BYTES;
    if (!shouldInlineConflictJson) {
      return {
        status: "needs-agent",
        reason:
          "Stella source-pack merge reported conflicts, but the handoff was too large for the install-update agent. Falling back to Git update.",
        headCommit: await readHeadCommit(stellaRoot),
        changedFiles: sourcePaths,
      };
    }
    await fs.rm(conflictRoot, { recursive: true, force: true });
    await fs.mkdir(conflictRoot, { recursive: true });
    await fs.writeFile(
      sourcePackFile,
      `${JSON.stringify(sourcePack, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(conflictFile, sourcePackConflictJson, "utf8");
    return {
      status: "needs-agent",
      reason: `Stella source-pack merge reported conflicts. Conflict details were written to ${conflictFile}.`,
      headCommit: await readHeadCommit(stellaRoot),
      changedFiles: sourcePaths,
      sourcePackFile,
      sourcePackConflictFile: conflictFile,
      ...(shouldInlineConflictJson ? { sourcePackConflictJson } : {}),
    };
  }

  if (sourceApply.appliedPaths.length === 0) {
    await recordSourceHistory();
    await refreshNativeHelpers(stellaRoot, args.releaseTag, args.artifactRefs);
    const manifest = await writeAppliedReleasePointer(
      stellaRoot,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaRoot),
      changedFiles: [],
      dependencyInstallRan: false,
      nativeHelpersRefreshed: true,
    };
  }

  if (!runner) {
    return {
      status: "needs-agent",
      reason: "Stella runtime is not available for the update morph.",
      changedFiles: sourceApply.appliedPaths,
    };
  }

  const runId = `desktop-update-source-pack:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  try {
    await runner.beginExternalSelfMod({
      runId,
      paths: sourceApply.appliedPaths,
    });
    hmrRunStarted = true;
    await writeSourcePackApplyResult({
      repoRoot: stellaRoot,
      paths: sourcePaths,
      tree: sourceApply.tree,
      appliedPaths: sourceApply.appliedPaths,
    });

    const addResult = await runGit(stellaRoot, [
      "add",
      "-A",
      "--",
      ...sourceApply.appliedPaths,
    ]);
    if (addResult.exitCode !== 0) {
      throw new Error(
        gitFailureDetail(addResult, "Could not stage source-pack update."),
      );
    }
    const commitResult = await runGit(stellaRoot, [
      "commit",
      "-m",
      `Update to ${args.releaseTag}`,
    ]);
    if (commitResult.exitCode !== 0) {
      throw new Error(
        gitFailureDetail(commitResult, "Could not commit source-pack update."),
      );
    }

    const dependencyInstallRan =
      sourceApply.appliedPaths.some(isDependencyChange);
    if (dependencyInstallRan) {
      let installResult: ProcessRunResult | null = null;
      let lastMissingBunError: Error | null = null;
      for (const bunCommand of candidateBunCommands()) {
        try {
          installResult = await runProcess(stellaRoot, bunCommand, [
            "install",
            "--frozen-lockfile",
          ]);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lastMissingBunError = error as Error;
            continue;
          }
          throw error;
        }
      }
      if (!installResult) {
        throw new Error(
          lastMissingBunError
            ? "Dependency install failed because Bun is not available."
            : "Dependency install failed because no Bun command was configured.",
        );
      }
      if (installResult.exitCode !== 0) {
        const detail = (installResult.stderr || installResult.stdout).trim();
        throw new Error(
          detail
            ? `Dependency install failed: ${detail}`
            : `Dependency install failed with exit code ${installResult.exitCode}.`,
        );
      }
    }

    await runner.finishExternalSelfMod({ runId, succeeded: true });
    hmrRunStarted = false;
    await recordSourceHistory(await readHeadCommit(stellaRoot));
    await refreshNativeHelpers(stellaRoot, args.releaseTag, args.artifactRefs);
    const manifest = await writeAppliedReleasePointer(
      stellaRoot,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaRoot),
      changedFiles: sourceApply.appliedPaths,
      dependencyInstallRan,
      nativeHelpersRefreshed: true,
    };
  } catch (error) {
    if (hmrRunStarted) {
      await runner
        .finishExternalSelfMod({ runId, succeeded: false })
        .catch(() => undefined);
    }
    throw error;
  }
};

const tryApplyCleanDesktopUpdate = async (
  stellaRoot: string,
  stellaHome: string,
  runner: StellaHostRunner | null,
  args: {
    baseCommit: string;
    targetCommit: string;
    releaseTag: string;
    sourcePackRef?: DesktopReleaseSourcePackRef;
    artifactRefs?: StellaReleaseArtifactRef[];
  },
): Promise<DesktopUpdateFastApplyResult> => {
  if (args.sourcePackRef) {
    try {
      const sourcePackResult = await tryApplySourcePackDesktopUpdate(
        stellaRoot,
        stellaHome,
        runner,
        {
          targetCommit: args.targetCommit,
          releaseTag: args.releaseTag,
          baseCommit: args.baseCommit,
          sourcePackRef: args.sourcePackRef,
          ...(args.artifactRefs ? { artifactRefs: args.artifactRefs } : {}),
        },
      );
      if (
        sourcePackResult.status === "applied" ||
        Boolean(sourcePackResult.sourcePackConflictFile)
      ) {
        return sourcePackResult;
      }
    } catch (error) {
      console.warn(
        "[updates] Source-pack update path failed; falling back to git:",
        error,
      );
    }
  }

  if (await hasMergeInProgress(stellaRoot)) {
    return {
      status: "needs-agent",
      reason: "A merge is already in progress in the install tree.",
    };
  }

  if (await hasTrackedWorkingTreeChanges(stellaRoot)) {
    return {
      status: "needs-agent",
      reason: "The install tree has tracked local changes.",
    };
  }

  const fetchResult = await runGit(stellaRoot, [
    "fetch",
    "--filter=blob:none",
    "--no-tags",
    "origin",
    args.targetCommit,
  ]);
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(fetchResult, "Failed to fetch the desktop update."),
    );
  }

  const alreadyApplied = await runGit(stellaRoot, [
    "merge-base",
    "--is-ancestor",
    args.targetCommit,
    "HEAD",
  ]);
  if (alreadyApplied.exitCode === 0) {
    await refreshNativeHelpers(stellaRoot, args.releaseTag, args.artifactRefs);
    const manifest = await writeAppliedCommit(
      stellaRoot,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaRoot),
      changedFiles: [],
      dependencyInstallRan: false,
      nativeHelpersRefreshed: true,
    };
  }

  const mergeTree = await runGit(stellaRoot, [
    "merge-tree",
    "--write-tree",
    "HEAD",
    args.targetCommit,
  ]);
  if (mergeTree.exitCode !== 0) {
    return {
      status: "needs-agent",
      reason: "Git reported merge conflicts.",
    };
  }

  const mergeTreeOid = mergeTree.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f]{40,64}$/i.test(line));
  if (!mergeTreeOid) {
    return {
      status: "needs-agent",
      reason: "Git could not preflight the merge tree.",
    };
  }

  const changedResult = await runGit(stellaRoot, [
    "diff",
    "--name-only",
    "HEAD",
    mergeTreeOid,
  ]);
  if (changedResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(changedResult, "Could not inspect update changes."),
    );
  }
  const changedFiles = parseGitNameList(changedResult.stdout);
  const runId = `desktop-update-fast:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  let mergeLanded = false;

  try {
    if (changedFiles.length > 0) {
      if (!runner) {
        return {
          status: "needs-agent",
          reason: "Stella runtime is not available for the update morph.",
          changedFiles,
        };
      }
      await runner.beginExternalSelfMod({ runId, paths: changedFiles });
      hmrRunStarted = true;
    }

    const mergeResult = await runGit(stellaRoot, [
      "merge",
      "--no-edit",
      "-m",
      `Update to ${args.releaseTag}`,
      args.targetCommit,
    ]);
    if (mergeResult.exitCode !== 0) {
      await abortMergeIfNeeded(stellaRoot);
      if (hmrRunStarted && runner) {
        await runner
          .finishExternalSelfMod({ runId, succeeded: false })
          .catch(() => undefined);
        hmrRunStarted = false;
      }
      return {
        status: "needs-agent",
        reason: gitFailureDetail(mergeResult, "Git could not merge cleanly."),
        changedFiles,
      };
    }
    mergeLanded = true;

    const dependencyInstallRan = changedFiles.some(isDependencyChange);
    if (dependencyInstallRan) {
      let installResult: ProcessRunResult | null = null;
      let lastMissingBunError: Error | null = null;
      for (const bunCommand of candidateBunCommands()) {
        try {
          installResult = await runProcess(stellaRoot, bunCommand, [
            "install",
            "--frozen-lockfile",
          ]);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lastMissingBunError = error as Error;
            continue;
          }
          throw error;
        }
      }
      if (!installResult) {
        throw new Error(
          lastMissingBunError
            ? "Dependency install failed because Bun is not available."
            : "Dependency install failed because no Bun command was configured.",
        );
      }
      if (installResult.exitCode !== 0) {
        const detail = (installResult.stderr || installResult.stdout).trim();
        throw new Error(
          detail
            ? `Dependency install failed: ${detail}`
            : `Dependency install failed with exit code ${installResult.exitCode}.`,
        );
      }
    }

    if (hmrRunStarted && runner) {
      await runner.finishExternalSelfMod({ runId, succeeded: true });
      hmrRunStarted = false;
    }

    await refreshNativeHelpers(stellaRoot, args.releaseTag, args.artifactRefs);
    const manifest = await writeAppliedCommit(
      stellaRoot,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaRoot),
      changedFiles,
      dependencyInstallRan,
      nativeHelpersRefreshed: true,
    };
  } catch (error) {
    if (hmrRunStarted && runner) {
      await runner
        .finishExternalSelfMod({ runId, succeeded: mergeLanded })
        .catch((finishError) => {
          console.warn(
            "[updates] Failed to finalize fast-update self-mod lifecycle:",
            finishError,
          );
        });
    }
    throw error;
  }
};

export const registerUpdatesHandlers = (options: UpdatesHandlersOptions) => {
  ipcMain.handle(
    IPC_UPDATES_GET_INSTALL_MANIFEST,
    async (event): Promise<InstallManifestSnapshot | null> => {
      if (
        !options.assertPrivilegedSender(event, IPC_UPDATES_GET_INSTALL_MANIFEST)
      ) {
        throw new Error(
          "Blocked untrusted updates:getInstallManifest request.",
        );
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) return null;
      return await readManifestWithRecovery(stellaRoot);
    },
  );

  ipcMain.handle(
    IPC_UPDATES_TRY_APPLY_CLEAN,
    async (
      event,
      payload: {
        baseCommit?: string;
        targetCommit?: string;
        releaseTag?: string;
        sourcePackRef?: DesktopReleaseSourcePackRef;
        artifactRefs?: StellaReleaseArtifactRef[];
      },
    ): Promise<DesktopUpdateFastApplyResult> => {
      if (!options.assertPrivilegedSender(event, IPC_UPDATES_TRY_APPLY_CLEAN)) {
        throw new Error(
          "Blocked untrusted updates:tryApplyCleanUpdate request.",
        );
      }
      const baseCommit = asString(payload?.baseCommit);
      if (!baseCommit) {
        throw new Error("baseCommit is required.");
      }
      const targetCommit = asString(payload?.targetCommit);
      if (!targetCommit) {
        throw new Error("targetCommit is required.");
      }
      const releaseTag = asString(payload?.releaseTag);
      if (!releaseTag) {
        throw new Error("releaseTag is required.");
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Stella install directory is unavailable.");
      }
      const stellaHome = options.getStellaHome();
      if (!stellaHome) {
        throw new Error("Stella home directory is unavailable.");
      }
      return await tryApplyCleanDesktopUpdate(
        stellaRoot,
        stellaHome,
        options.getStellaHostRunner?.() ?? null,
        {
          baseCommit,
          targetCommit,
          releaseTag,
          ...(payload.sourcePackRef
            ? { sourcePackRef: payload.sourcePackRef }
            : {}),
          ...(Array.isArray(payload.artifactRefs)
            ? { artifactRefs: payload.artifactRefs }
            : {}),
        },
      );
    },
  );

  ipcMain.handle(
    IPC_UPDATES_REFRESH_NATIVE_HELPERS,
    async (
      event,
      payload: {
        releaseTag?: string;
        artifactRefs?: StellaReleaseArtifactRef[];
      },
    ): Promise<{
      ok: boolean;
      manifestUrl: string;
      stdout: string;
      stderr: string;
    }> => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_UPDATES_REFRESH_NATIVE_HELPERS,
        )
      ) {
        throw new Error(
          "Blocked untrusted updates:refreshNativeHelpers request.",
        );
      }
      const releaseTag = asString(payload?.releaseTag);
      if (!releaseTag) {
        throw new Error("releaseTag is required.");
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Stella install directory is unavailable.");
      }
      const result = await refreshNativeHelpers(
        stellaRoot,
        releaseTag,
        Array.isArray(payload.artifactRefs) ? payload.artifactRefs : undefined,
      );
      return { ok: true, ...result };
    },
  );

  ipcMain.handle(
    IPC_UPDATES_RECORD_SOURCE_HISTORY,
    async (
      event,
      payload: {
        targetCommit?: string;
        releaseTag?: string;
        sourceHistoryRef?: DesktopReleaseSourceHistoryRef;
      },
    ): Promise<
      { ok: true; revisionId: string } | { ok: false; reason: string }
    > => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_UPDATES_RECORD_SOURCE_HISTORY,
        )
      ) {
        throw new Error(
          "Blocked untrusted updates:recordSourceHistory request.",
        );
      }
      const targetCommit = asString(payload?.targetCommit);
      if (!targetCommit) {
        throw new Error("targetCommit is required.");
      }
      const releaseTag = asString(payload?.releaseTag);
      if (!releaseTag) {
        throw new Error("releaseTag is required.");
      }
      let sourceHistoryRef = payload?.sourceHistoryRef ?? null;
      if (!sourceHistoryRef) {
        sourceHistoryRef = await fetchDesktopReleaseSourceHistoryRef({
          releaseTag,
          targetCommit,
        });
      }
      if (!sourceHistoryRef) {
        return { ok: false, reason: "source-history-unavailable" };
      }
      const runner = options.getStellaHostRunner?.() ?? null;
      if (!runner) {
        return { ok: false, reason: "runtime-unavailable" };
      }
      const sourcePack = await fetchDesktopSourceHistoryPack(sourceHistoryRef);
      await recordDesktopUpdateSourceHistory(runner, {
        sourcePack,
        releaseTag,
        targetCommit,
        origin: "official",
      });
      return { ok: true, revisionId: sourcePack.revisionId };
    },
  );

  ipcMain.handle(
    IPC_UPDATES_RECORD_APPLIED_COMMIT,
    async (
      event,
      payload: {
        commit?: string;
        tag?: string;
        mode?: "git-ancestry" | "release-pointer";
        startingHeadCommit?: string;
      },
    ): Promise<InstallManifestSnapshot | null> => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_UPDATES_RECORD_APPLIED_COMMIT,
        )
      ) {
        throw new Error(
          "Blocked untrusted updates:recordAppliedCommit request.",
        );
      }
      const commit = asString(payload?.commit);
      if (!commit) {
        throw new Error("commit is required.");
      }
      const tag = asString(payload?.tag);
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Stella install directory is unavailable.");
      }
      if (payload?.mode === "release-pointer") {
        const startingHeadCommit = asString(payload.startingHeadCommit);
        if (!startingHeadCommit) {
          throw new Error("startingHeadCommit is required.");
        }
        if (await hasMergeInProgress(stellaRoot)) {
          throw new Error("A merge is still in progress in the install tree.");
        }
        if (await hasTrackedWorkingTreeChanges(stellaRoot)) {
          throw new Error("The install tree still has tracked local changes.");
        }
        const currentHead = await readHeadCommit(stellaRoot);
        if (currentHead === startingHeadCommit) {
          throw new Error(
            "The install-update agent did not create an update commit.",
          );
        }
        return await writeAppliedReleasePointer(stellaRoot, commit, tag);
      }
      return await writeAppliedCommit(stellaRoot, commit, tag);
    },
  );
};
