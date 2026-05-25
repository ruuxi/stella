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
import { promises as fs } from "node:fs";
import path from "node:path";
import { setupEnvironment } from "dugite";
import {
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
  IPC_UPDATES_REFRESH_NATIVE_HELPERS,
  IPC_UPDATES_TRY_APPLY_CLEAN,
} from "../../src/shared/contracts/ipc-channels.js";
import type { StellaHostRunner } from "../stella-host-runner.js";

const INSTALL_MANIFEST_BASENAME = "stella-install.json";
const DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers";
const DEFAULT_NATIVE_HELPERS_MANIFEST_URL = `${DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL}/current.json`;

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
): Promise<{ manifestUrl: string; stdout: string; stderr: string }> => {
  const manifestUrl = getNativeHelpersManifestUrl();
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
      changedFiles?: string[];
    };

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

const tryApplyCleanDesktopUpdate = async (
  stellaRoot: string,
  runner: StellaHostRunner | null,
  args: {
    baseCommit: string;
    targetCommit: string;
    releaseTag: string;
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
    await refreshNativeHelpers(stellaRoot, args.releaseTag);
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

    await refreshNativeHelpers(stellaRoot, args.releaseTag);
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
      return await tryApplyCleanDesktopUpdate(
        stellaRoot,
        options.getStellaHostRunner?.() ?? null,
        { baseCommit, targetCommit, releaseTag },
      );
    },
  );

  ipcMain.handle(
    IPC_UPDATES_REFRESH_NATIVE_HELPERS,
    async (
      event,
      payload: { releaseTag?: string },
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
      const result = await refreshNativeHelpers(stellaRoot, releaseTag);
      return { ok: true, ...result };
    },
  );

  ipcMain.handle(
    IPC_UPDATES_RECORD_APPLIED_COMMIT,
    async (
      event,
      payload: { commit?: string; tag?: string },
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
      return await writeAppliedCommit(stellaRoot, commit, tag);
    },
  );
};
