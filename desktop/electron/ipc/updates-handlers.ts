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
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setupEnvironment } from "dugite";
import {
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
  IPC_UPDATES_RECORD_SOURCE_HISTORY,
  IPC_UPDATES_REFRESH_NATIVE_HELPERS,
  IPC_UPDATES_ROLLBACK_CANCELED,
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
  type StellaSourceApplyResult,
  type StellaSourceApplyConflict,
  type StellaSourceBlob,
} from "../../../runtime/kernel/self-mod/stella-source-control.js";
import { rollbackGitChangesSince } from "../../../runtime/kernel/self-mod/git/revert.js";
import { isRuntimeUnavailableError } from "../../../runtime/protocol/rpc-peer.js";
import {
  applyCleanSourceImportToWorkingTree,
  preflightSourcePackImport,
} from "../../../runtime/worker/source-import-core.js";
import {
  STORE_PUBLISH_DEPENDENCY_FILE_NAMES,
  runStorePublishDependencyInstall,
  storePublishTouchesDependencyFiles,
} from "../../../runtime/worker/store-source-pack-install.js";
import {
  desktopSourcePackCanApplyLocally,
  desktopSourcePackMatchesBaseCommit,
  desktopReleaseManifestUrl,
  recordDesktopUpdateSourceHistory,
  sourceHistoryRefFromDesktopReleaseManifest,
} from "./desktop-source-history.js";
import {
  getFileLogger,
  type LogFields,
} from "../../../runtime/observability/file-logger.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { invalidateNativeHelperPathCache } from "../native-helper-path.js";

const INSTALL_MANIFEST_BASENAME = "stella-install.json";
const RELEASE_MANIFEST_BASENAME = "stella-release.json";
const DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers";
const DEFAULT_NATIVE_HELPERS_MANIFEST_URL = `${DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL}/current.json`;
const UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS = 120_000;
// Recording source history is best-effort and may run after launch or after an
// update. Keep it out of renderer startup and wait for real runtime readiness
// before issuing the worker RPC.
const UPDATE_SOURCE_HISTORY_TIMEOUT_MS = 45_000;
const UPDATE_DOWNLOAD_RETRY_DELAYS_MS = [750, 1_500, 3_000, 6_000];
// The per-launch source-history reconciliation (`runner-ready`) is a background
// safety net for the CURRENT install commit — nothing the user does in the first
// seconds of a session depends on it. Firing it immediately on runner-ready (a
// setTimeout(0)) lands its slow worker RPC (`hasSourceRevisionForCommit`, ~6s on
// a cold Windows worker) right in the middle of worker warmup, so it competes
// with first chat readiness. Delay it past the warmup window so it runs while
// the app is idle. Post-update triggers (`clean-update-applied`,
// `applied-commit-recorded`) stay immediate — those are genuinely time-sensitive.
const OFFICIAL_SOURCE_HISTORY_STARTUP_DELAY_MS = 20_000;

class DesktopUpdateRuntimeTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Desktop update phase "${phase}" timed out after ${Math.round(timeoutMs / 1000)}s.`,
    );
    this.name = "DesktopUpdateRuntimeTimeoutError";
  }
}

const shortCommit = (commit: string | null | undefined): string | undefined =>
  commit ? commit.slice(0, 12) : undefined;

const logDesktopUpdateProcess = (event: string, fields?: LogFields) => {
  getFileLogger()?.process(event, fields);
};

const logDesktopUpdateWarn = (event: string, fields?: LogFields) => {
  getFileLogger()?.warn(event, fields);
};

const logDesktopUpdateError = (
  event: string,
  error: unknown,
  fields?: LogFields,
) => {
  getFileLogger()?.error(event, {
    ...(fields ?? {}),
    error,
  });
};

class RetryableDownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RetryableDownloadError";
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isRetryableHttpStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const errorMessageWithCause = (error: unknown): string => {
  if (error instanceof Error) {
    const cause =
      typeof error.cause === "string"
        ? error.cause
        : error.cause instanceof Error
          ? error.cause.message
          : "";
    return `${error.message} ${cause}`.trim();
  }
  return String(error);
};

const isRetryableDownloadError = (error: unknown): boolean => {
  if (error instanceof RetryableDownloadError) return true;
  return /fetch failed|network|timeout|timed out|econnreset|etimedout|eai_again|enotfound|socket|terminated|aborted/i.test(
    errorMessageWithCause(error),
  );
};

const withDownloadRetries = async <T>(
  label: string,
  url: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let lastError: unknown;
  for (
    let attemptIndex = 0;
    attemptIndex <= UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length;
    attemptIndex += 1
  ) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const nextDelayMs = UPDATE_DOWNLOAD_RETRY_DELAYS_MS[attemptIndex];
      if (nextDelayMs === undefined || !isRetryableDownloadError(error)) {
        throw error;
      }
      logDesktopUpdateWarn("desktop-update.download.retry", {
        label,
        url,
        attempt: attemptIndex + 1,
        nextAttempt: attemptIndex + 2,
        nextDelayMs,
        error: errorMessageWithCause(error),
      });
      await wait(nextDelayMs);
    }
  }
  throw lastError;
};

const withDesktopUpdateTimeout = async <T>(
  phase: string,
  timeoutMs: number,
  promise: Promise<T>,
  fields?: LogFields,
): Promise<T> => {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  logDesktopUpdateProcess("desktop-update.phase.start", {
    phase,
    timeoutMs,
    ...(fields ?? {}),
  });
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DesktopUpdateRuntimeTimeoutError(phase, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([promise, timeout]);
    logDesktopUpdateProcess("desktop-update.phase.done", {
      phase,
      elapsedMs: Date.now() - startedAt,
      ...(fields ?? {}),
    });
    return result;
  } catch (error) {
    const logFields = {
      phase,
      elapsedMs: Date.now() - startedAt,
      ...(fields ?? {}),
      error,
    };
    if (error instanceof DesktopUpdateRuntimeTimeoutError) {
      logDesktopUpdateWarn("desktop-update.phase.timeout", logFields);
    } else {
      logDesktopUpdateError("desktop-update.phase.failed", error, logFields);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

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

const nativeHelperPlatformDir = (): string | null => {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return null;
};

export type InstallStateSnapshot = {
  status: "complete";
  desktopReleaseTag: string | null;
  desktopReleaseCommit: string;
  localHeadCommit: string | null;
  nativeHelpersSha: string | null;
  completedAt: string;
};

export type UpdateAttemptPhase =
  | "started"
  | "source-pack-preflight"
  | "source-pack-write"
  | "source-pack-commit"
  | "git-fetch"
  | "git-merge"
  | "dependency-install"
  | "native-refresh"
  | "record-complete"
  | "agent-fallback";

export type UpdateAttemptMode =
  | "source-pack"
  | "git"
  | "native-helpers"
  | "agent";

export type UpdateAttemptRecoveryAction =
  | "resume"
  | "discard"
  | "needs-agent";

export type UpdateAttemptSnapshot = {
  status: "updating" | "complete" | "failed";
  targetTag: string | null;
  targetCommit: string;
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  operationId: string | null;
  phase: UpdateAttemptPhase | null;
  mode: UpdateAttemptMode | null;
  recoveryAction: UpdateAttemptRecoveryAction | null;
  startingHeadCommit: string | null;
  updatedAt: string | null;
  changedFiles: string[];
  ownedTempPaths: string[];
  nativeHelpersManifestUrl: string | null;
};

export type InstallManifestSnapshot = {
  version: string;
  platform: string;
  installPath: string;
  installedAt: string;
  desktopReleaseTag: string | null;
  desktopReleaseCommit: string | null;
  desktopInstallBaseCommit: string | null;
  installState: InstallStateSnapshot | null;
  lastUpdateAttempt: UpdateAttemptSnapshot | null;
};

export type UpdatesHandlersOptions = {
  getStellaAppDir: () => string | null;
  getStellaDataDir: () => string | null;
  getStellaHostRunner?: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const manifestPathFromRoot = (stellaAppDir: string): string =>
  path.join(stellaAppDir, INSTALL_MANIFEST_BASENAME);

const releaseManifestPathFromRoot = (stellaAppDir: string): string =>
  path.join(stellaAppDir, RELEASE_MANIFEST_BASENAME);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const parseUpdateAttemptPhase = (
  value: unknown,
): UpdateAttemptPhase | null => {
  switch (value) {
    case "started":
    case "source-pack-preflight":
    case "source-pack-write":
    case "source-pack-commit":
    case "git-fetch":
    case "git-merge":
    case "dependency-install":
    case "native-refresh":
    case "record-complete":
    case "agent-fallback":
      return value;
    default:
      return null;
  }
};

const parseUpdateAttemptMode = (value: unknown): UpdateAttemptMode | null => {
  switch (value) {
    case "source-pack":
    case "git":
    case "native-helpers":
    case "agent":
      return value;
    default:
      return null;
  }
};

const parseUpdateAttemptRecoveryAction = (
  value: unknown,
): UpdateAttemptRecoveryAction | null => {
  switch (value) {
    case "resume":
    case "discard":
    case "needs-agent":
      return value;
    default:
      return null;
  }
};

const requireString = (value: unknown, field: string): string => {
  const v = asString(value);
  if (!v) {
    throw new Error(`Install manifest field ${field} is missing or empty.`);
  }
  return v;
};

const parseInstallStateSnapshot = (
  value: unknown,
): InstallStateSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.status !== "complete") return null;
  const desktopReleaseCommit = asString(record.desktopReleaseCommit);
  const completedAt = asString(record.completedAt);
  if (!desktopReleaseCommit || !completedAt) return null;
  return {
    status: "complete",
    desktopReleaseTag: asString(record.desktopReleaseTag),
    desktopReleaseCommit,
    localHeadCommit: asString(record.localHeadCommit),
    nativeHelpersSha: asString(record.nativeHelpersSha),
    completedAt,
  };
};

const parseUpdateAttemptSnapshot = (
  value: unknown,
): UpdateAttemptSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.status !== "updating" &&
    record.status !== "complete" &&
    record.status !== "failed"
  ) {
    return null;
  }
  const targetCommit = asString(record.targetCommit);
  const startedAt = asString(record.startedAt);
  if (!targetCommit || !startedAt) return null;
  return {
    status: record.status,
    targetTag: asString(record.targetTag),
    targetCommit,
    startedAt,
    finishedAt: asString(record.finishedAt),
    reason: asString(record.reason),
    operationId: asString(record.operationId),
    phase: parseUpdateAttemptPhase(record.phase),
    mode: parseUpdateAttemptMode(record.mode),
    recoveryAction: parseUpdateAttemptRecoveryAction(record.recoveryAction),
    startingHeadCommit: asString(record.startingHeadCommit),
    updatedAt: asString(record.updatedAt),
    changedFiles: asStringArray(record.changedFiles),
    ownedTempPaths: asStringArray(record.ownedTempPaths),
    nativeHelpersManifestUrl: asString(record.nativeHelpersManifestUrl),
  };
};

type GitRunResult = { exitCode: number; stdout: string; stderr: string };
type ProcessRunResult = { exitCode: number; stdout: string; stderr: string };
type ReleaseManifestSnapshot = {
  tag: string | null;
  commit: string | null;
  sourceHistoryRef: DesktopReleaseSourceHistoryRef | null;
};
type OfficialSourceHistoryRecordResult =
  | { ok: true; revisionId: string }
  | { ok: false; reason: string };

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

const readInstalledNativeHelpersSha = async (
  stellaAppDir: string,
): Promise<string | null> => {
  const platformDir = nativeHelperPlatformDir();
  if (!platformDir) return null;
  try {
    const raw = await fs.readFile(
      path.join(
        stellaAppDir,
        "desktop",
        "native",
        "out",
        platformDir,
        ".stella-native-helpers.json",
      ),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return asString(parsed.sha);
  } catch {
    return null;
  }
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

const nativeHelperTempPathPatterns = (platformKey: string): string[] => [
  ".stella-native-helpers-download.tar.zst",
  `.stella-native-helpers-extract-${platformKey}-*`,
  `.stella-native-helpers-files-${platformKey}-*`,
];

const resolveNativeHelpersManifestUrl = (
  platformKey: string,
  artifactRefs?: StellaReleaseArtifactRef[],
): string => {
  const releaseNativeRef = artifactRefs?.find(
    (ref) => ref.kind === "native-helpers" && ref.platform === platformKey,
  );
  return releaseNativeRef?.manifestUrl ?? getNativeHelpersManifestUrl();
};

const refreshNativeHelpers = async (
  stellaAppDir: string,
  _releaseTag?: string,
  artifactRefs?: StellaReleaseArtifactRef[],
  options?: {
    transaction?: DesktopUpdateTransaction | null;
    mode?: UpdateAttemptMode;
    changedFiles?: string[];
    manifestUrl?: string;
  },
): Promise<{ manifestUrl: string; stdout: string; stderr: string }> => {
  const platformKey = nativeHelperPlatformKey();
  const manifestUrl =
    options?.manifestUrl ??
    resolveNativeHelpersManifestUrl(platformKey, artifactRefs);
  const ownedTempPaths = nativeHelperTempPathPatterns(platformKey);
  await writeDesktopUpdatePhase(stellaAppDir, options?.transaction, {
    phase: "native-refresh",
    mode: options?.mode ?? "native-helpers",
    recoveryAction: "resume",
    changedFiles: options?.changedFiles,
    ownedTempPaths,
    nativeHelpersManifestUrl: manifestUrl,
  });
  const scriptPath = path.join(
    stellaAppDir,
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
      result = await runProcess(stellaAppDir, bunCommand, [
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
    invalidateNativeHelperPathCache();
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
      /**
       * True when the running app verifiably reloaded onto the updated code
       * (the external self-mod morph/reload cycle completed). When false the
       * update landed on disk but the app is still executing the old code —
       * callers must not report the update as applied-and-live; a restart
       * (or a retry, which replays the reload) finishes it.
       */
      reloaded: boolean;
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

type DesktopUpdateRollbackResult =
  | {
      status: "rolled-back";
      headCommit: string;
      restoredFiles: string[];
    }
  | {
      status: "skipped";
      reason: string;
      headCommit?: string;
    };

const MAX_DESKTOP_SOURCE_PACK_BYTES = 10 * 1024 * 1024;
const MAX_DESKTOP_SOURCE_HISTORY_BYTES = 10 * 1024 * 1024;
const MAX_DESKTOP_SOURCE_PACK_CONFLICT_PROMPT_BYTES = 200 * 1024;

const parseGitNameList = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const expandExternalSelfModPaths = (paths: string[]): string[] => {
  const expanded = new Set(paths);
  if (storePublishTouchesDependencyFiles(paths)) {
    for (const dependencyFile of STORE_PUBLISH_DEPENDENCY_FILE_NAMES) {
      expanded.add(dependencyFile);
    }
  }
  return [...expanded];
};

type ReacquireRunner = () => Promise<StellaHostRunner>;

/**
 * True when a runner RPC failed because the runtime worker's transport went
 * away mid-call (the worker restarted or was restarting underneath the
 * caller), as opposed to a real handler failure.
 */
const isRuntimeTransportClosedError = (error: unknown): boolean =>
  isRuntimeUnavailableError(error) ||
  /transport is closed|peer is closed|runtime is not available/i.test(
    error instanceof Error ? error.message : String(error),
  );

/**
 * Finish an external self-mod update run, tolerating the runtime worker
 * restarting underneath the update.
 *
 * Updates that ship runtime/ code (and concurrent self-mod applies) can
 * restart the worker while this flow still holds RPCs against the old
 * transport. Without recovery the update then fails with "Runtime RPC
 * transport is closed" AFTER the working tree was already updated and
 * committed, the host-side runtime-reload pause registered by
 * `beginExternalSelfMod` leaks, and the morph/reload never runs — the app
 * keeps executing old code while a retry sees a no-op tree and would
 * fake-report success.
 *
 * Recovery: re-issue the finish against the reconnected worker (idempotent —
 * an unknown runId just releases the leaked reload pause), then replay a
 * fresh begin/finish cycle over the same paths so the renderer actually
 * reloads the updated code. Returns whether the reload cycle is known to
 * have completed.
 */
const finishUpdateSelfModRun = async (args: {
  runner: StellaHostRunner;
  reacquireRunner?: ReacquireRunner | undefined;
  runId: string;
  paths: string[];
  logScope: "source-pack" | "git" | "agent-recovery";
  logFields: LogFields;
}): Promise<{ reloaded: boolean }> => {
  try {
    await args.runner.finishExternalSelfMod({
      runId: args.runId,
      succeeded: true,
    });
    return { reloaded: true };
  } catch (error) {
    if (!isRuntimeTransportClosedError(error) || !args.reacquireRunner) {
      throw error;
    }
    logDesktopUpdateWarn(
      `desktop-update.${args.logScope}.finish-transport-closed`,
      {
        ...args.logFields,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    let reconnected: StellaHostRunner;
    try {
      reconnected = await args.reacquireRunner();
    } catch (reconnectError) {
      logDesktopUpdateError(
        `desktop-update.${args.logScope}.reconnect-failed`,
        reconnectError,
        args.logFields,
      );
      return { reloaded: false };
    }
    // Unknown runId on the fresh worker → releases the leaked reload pause.
    await reconnected
      .finishExternalSelfMod({ runId: args.runId, succeeded: true })
      .catch(() => undefined);
    if (args.paths.length === 0) {
      return { reloaded: false };
    }
    const replayRunId = `${args.runId}:reload-replay`;
    try {
      await reconnected.beginExternalSelfMod({
        runId: replayRunId,
        paths: expandExternalSelfModPaths(args.paths),
      });
      await reconnected.finishExternalSelfMod({
        runId: replayRunId,
        succeeded: true,
      });
      logDesktopUpdateProcess(
        `desktop-update.${args.logScope}.reload-replayed`,
        args.logFields,
      );
      return { reloaded: true };
    } catch (replayError) {
      logDesktopUpdateError(
        `desktop-update.${args.logScope}.reload-replay-failed`,
        replayError,
        args.logFields,
      );
      await args
        .reacquireRunner()
        .then((fresh) =>
          fresh.finishExternalSelfMod({ runId: replayRunId, succeeded: false }),
        )
        .catch(() => undefined);
      return { reloaded: false };
    }
  }
};

const gitFailureDetail = (result: GitRunResult, fallback: string): string => {
  const detail = (result.stderr || result.stdout).trim();
  return detail || fallback;
};

const runDesktopUpdateDependencyInstall = async (args: {
  stellaAppDir: string;
  changedFiles: string[];
  runId: string;
  releaseTag: string;
}): Promise<boolean> => {
  const dependencyInstallRan = storePublishTouchesDependencyFiles(
    args.changedFiles,
  );
  if (!dependencyInstallRan) return false;

  logDesktopUpdateProcess("desktop-update.dependencies.install.start", {
    runId: args.runId,
    releaseTag: args.releaseTag,
  });
  await runStorePublishDependencyInstall(args.stellaAppDir);
  logDesktopUpdateProcess("desktop-update.dependencies.install.done", {
    runId: args.runId,
    releaseTag: args.releaseTag,
  });
  return true;
};

const readHeadCommit = async (stellaAppDir: string): Promise<string> => {
  const result = await runGit(stellaAppDir, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(gitFailureDetail(result, "Could not read current HEAD."));
  }
  return result.stdout.trim();
};

const hasMergeInProgress = async (stellaAppDir: string): Promise<boolean> => {
  try {
    await fs.access(path.join(stellaAppDir, ".git", "MERGE_HEAD"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};

const hasTrackedWorkingTreeChanges = async (
  stellaAppDir: string,
): Promise<boolean> => {
  const status = await runGit(stellaAppDir, [
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

const listTrackedWorkingTreeChanges = async (
  stellaAppDir: string,
): Promise<string[]> => {
  const status = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (status.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(status, "Could not inspect install tree status."),
    );
  }
  return status.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const pathPart = line.slice(3).trim();
      const renameMarker = pathPart.lastIndexOf(" -> ");
      return (renameMarker >= 0
        ? pathPart.slice(renameMarker + 4)
        : pathPart
      ).replace(/\\/g, "/");
    })
    .filter(Boolean);
};

const repoPathOverlaps = (left: string, right: string): boolean => {
  const a = left.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const b = right.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

const findOverlappingRepoPaths = (
  leftPaths: string[],
  rightPaths: string[],
): string[] =>
  leftPaths.filter((left) =>
    rightPaths.some((right) => repoPathOverlaps(left, right)),
  );

const abortMergeIfNeeded = async (stellaAppDir: string) => {
  if (!(await hasMergeInProgress(stellaAppDir))) return;
  await runGit(stellaAppDir, ["merge", "--abort"]).catch(() => undefined);
};

const updateCommitSubjectPolicy = (releaseTag: string | null) => {
  const expected = releaseTag ? `Update to ${releaseTag}` : null;
  return (subject: string) =>
    expected ? subject === expected : subject.startsWith("Update to ");
};

const rollbackCanceledDesktopUpdate = async (
  stellaAppDir: string,
  args: {
    startingHeadCommit: string;
    releaseTag: string | null;
    changedFiles?: string[];
  },
): Promise<DesktopUpdateRollbackResult> => {
  const startingHeadCommit = args.startingHeadCommit.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(startingHeadCommit)) {
    return {
      status: "skipped",
      reason: "The update rollback starting commit is invalid.",
    };
  }

  logDesktopUpdateProcess("desktop-update.rollback.start", {
    releaseTag: args.releaseTag,
    startingHeadCommit: shortCommit(startingHeadCommit),
    changedFileCount: args.changedFiles?.length ?? 0,
  });

  const result = await rollbackGitChangesSince({
    repoRoot: stellaAppDir,
    startingHeadCommit,
    changedFiles: args.changedFiles,
    isOwnedCommitSubject: updateCommitSubjectPolicy(args.releaseTag),
  });
  if (result.status === "skipped") {
    logDesktopUpdateWarn("desktop-update.rollback.skipped", {
      releaseTag: args.releaseTag,
      headCommit: result.headCommit ? shortCommit(result.headCommit) : null,
      reason: result.reason,
    });
    return {
      status: "skipped",
      reason: result.reason,
      ...(result.headCommit ? { headCommit: result.headCommit } : {}),
    };
  }
  logDesktopUpdateProcess("desktop-update.rollback.rolled-back", {
    releaseTag: args.releaseTag,
    headCommit: result.headCommit ? shortCommit(result.headCommit) : null,
    restoredFileCount: result.restoredFiles.length,
  });
  return {
    status: "rolled-back",
    headCommit: result.headCommit ?? startingHeadCommit,
    restoredFiles: result.restoredFiles,
  };
};

const writeAppliedCommit = async (
  stellaAppDir: string,
  commit: string,
  tag: string | null,
): Promise<InstallManifestSnapshot | null> => {
  const verification = await verifyMergeApplied(stellaAppDir, commit);
  if (!verification.ok) {
    throw new Error(verification.reason);
  }
  const manifestPath = manifestPathFromRoot(stellaAppDir);
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    parseManifest(raw);
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const recovered = await readManifestWithRecovery(stellaAppDir);
    if (recovered) {
      parsed = {
        version: recovered.version,
        platform: recovered.platform,
        installPath: recovered.installPath,
        installedAt: recovered.installedAt,
        desktopReleaseTag: recovered.desktopReleaseTag,
        desktopReleaseCommit: recovered.desktopReleaseCommit,
        desktopInstallBaseCommit: recovered.desktopInstallBaseCommit,
        installState: recovered.installState,
        lastUpdateAttempt: recovered.lastUpdateAttempt,
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
  const nativeHelpersSha = await readInstalledNativeHelpersSha(stellaAppDir);
  parsed.installState = {
    status: "complete",
    desktopReleaseTag: tag ?? asString(parsed.desktopReleaseTag),
    desktopReleaseCommit: commit,
    localHeadCommit: verification.headCommit,
    nativeHelpersSha,
    completedAt: new Date().toISOString(),
  };
  const previousAttempt = parseUpdateAttemptSnapshot(parsed.lastUpdateAttempt);
  parsed.lastUpdateAttempt = {
    status: "complete",
    targetTag: tag,
    targetCommit: commit,
    startedAt: previousAttempt?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    reason: null,
    operationId: previousAttempt?.operationId ?? null,
    phase: "record-complete",
    mode: previousAttempt?.mode ?? "git",
    recoveryAction: previousAttempt?.recoveryAction ?? "resume",
    startingHeadCommit: previousAttempt?.startingHeadCommit ?? null,
    updatedAt: new Date().toISOString(),
    changedFiles: previousAttempt?.changedFiles ?? [],
    ownedTempPaths: previousAttempt?.ownedTempPaths ?? [],
    nativeHelpersManifestUrl:
      previousAttempt?.nativeHelpersManifestUrl ?? null,
  };
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  parseManifest(next);
  await writeFileAtomic(manifestPath, next);
  await writeAppliedReleaseManifest(stellaAppDir, commit, tag).catch((error) => {
    logDesktopUpdateWarn("desktop-update.release-manifest.write-failed", {
      tag: tag ?? undefined,
      commit: shortCommit(commit),
      error,
    });
  });
  return parseManifest(next);
};

const writeAppliedReleasePointer = async (
  stellaAppDir: string,
  commit: string,
  tag: string | null,
): Promise<InstallManifestSnapshot | null> => {
  const manifestPath = manifestPathFromRoot(stellaAppDir);
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    parseManifest(raw);
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const recovered = await readManifestWithRecovery(stellaAppDir);
    if (recovered) {
      parsed = {
        version: recovered.version,
        platform: recovered.platform,
        installPath: recovered.installPath,
        installedAt: recovered.installedAt,
        desktopReleaseTag: recovered.desktopReleaseTag,
        desktopReleaseCommit: recovered.desktopReleaseCommit,
        desktopInstallBaseCommit: recovered.desktopInstallBaseCommit,
        installState: recovered.installState,
        lastUpdateAttempt: recovered.lastUpdateAttempt,
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
  const nativeHelpersSha = await readInstalledNativeHelpersSha(stellaAppDir);
  const localHeadCommit = await readHeadCommit(stellaAppDir).catch(() => null);
  parsed.installState = {
    status: "complete",
    desktopReleaseTag: tag ?? asString(parsed.desktopReleaseTag),
    desktopReleaseCommit: commit,
    localHeadCommit,
    nativeHelpersSha,
    completedAt: new Date().toISOString(),
  };
  const previousAttempt = parseUpdateAttemptSnapshot(parsed.lastUpdateAttempt);
  parsed.lastUpdateAttempt = {
    status: "complete",
    targetTag: tag,
    targetCommit: commit,
    startedAt: previousAttempt?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    reason: null,
    operationId: previousAttempt?.operationId ?? null,
    phase: "record-complete",
    mode: previousAttempt?.mode ?? "source-pack",
    recoveryAction: previousAttempt?.recoveryAction ?? "resume",
    startingHeadCommit: previousAttempt?.startingHeadCommit ?? null,
    updatedAt: new Date().toISOString(),
    changedFiles: previousAttempt?.changedFiles ?? [],
    ownedTempPaths: previousAttempt?.ownedTempPaths ?? [],
    nativeHelpersManifestUrl:
      previousAttempt?.nativeHelpersManifestUrl ?? null,
  };
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  parseManifest(next);
  await writeFileAtomic(manifestPath, next);
  await writeAppliedReleaseManifest(stellaAppDir, commit, tag).catch((error) => {
    logDesktopUpdateWarn("desktop-update.release-manifest.write-failed", {
      tag: tag ?? undefined,
      commit: shortCommit(commit),
      error,
    });
  });
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
  stellaAppDir: string,
  targetCommit: string,
): Promise<VerifyResult> => {
  const gitDir = await runGit(stellaAppDir, ["rev-parse", "--git-dir"]);
  if (gitDir.exitCode !== 0) {
    return {
      ok: false,
      reason: "Install directory is not a git repository.",
    };
  }
  try {
    await fs.access(path.join(stellaAppDir, ".git", "MERGE_HEAD"));
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
  const isAncestor = await runGit(stellaAppDir, [
    "merge-base",
    "--is-ancestor",
    targetCommit,
    "HEAD",
  ]);
  if (isAncestor.exitCode !== 0) {
    return {
      ok: false,
      reason: `Stella could not confirm the update was applied. The update agent finished, but this install is still not on ${targetCommit.slice(0, 8)}. Please try Update again.`,
    };
  }
  const headRev = await runGit(stellaAppDir, ["rev-parse", "HEAD"]);
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
    installState: parseInstallStateSnapshot(parsed.installState),
    lastUpdateAttempt: parseUpdateAttemptSnapshot(parsed.lastUpdateAttempt),
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
  stellaAppDir: string,
): Promise<ReleaseManifestSnapshot> => {
  try {
    const raw = await fs.readFile(
      path.join(stellaAppDir, "stella-release.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const commit = asString(parsed.commit);
    return {
      tag: asString(parsed.tag),
      commit,
      sourceHistoryRef: commit
        ? sourceHistoryRefFromDesktopReleaseManifest(parsed, {
            targetCommit: commit,
          })
        : null,
    };
  } catch {
    return { tag: null, commit: null, sourceHistoryRef: null };
  }
};

const recoverManifest = async (
  stellaAppDir: string,
): Promise<InstallManifestSnapshot | null> => {
  const tracked = await readGitFile(
    stellaAppDir,
    `HEAD:${INSTALL_MANIFEST_BASENAME}`,
  );
  if (tracked) {
    const parsed = tryParseManifest(tracked, "git HEAD");
    if (parsed) return parsed;
  }

  const release = await readReleaseManifest(stellaAppDir);
  const head = await runGit(stellaAppDir, ["rev-parse", "HEAD"]);
  return {
    version: "recovered",
    platform: process.platform,
    installPath: stellaAppDir,
    installedAt: new Date().toISOString(),
    desktopReleaseTag: release.tag,
    desktopReleaseCommit:
      release.commit ?? (head.exitCode === 0 ? head.stdout.trim() : null),
    desktopInstallBaseCommit: null,
    installState: null,
    lastUpdateAttempt: null,
  };
};

const readManifestWithRecovery = async (
  stellaAppDir: string,
): Promise<InstallManifestSnapshot | null> => {
  const manifestPath = manifestPathFromRoot(stellaAppDir);
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
  return await recoverManifest(stellaAppDir);
};

type RecordAppliedCommitMode = "git-ancestry" | "release-pointer";

const listRecoveredAgentChangedFiles = async (
  stellaAppDir: string,
  attempt: UpdateAttemptSnapshot,
  fallbackStartingHeadCommit: string | null,
): Promise<string[]> => {
  const changedFiles = new Set(attempt.changedFiles);
  const startingHeadCommit =
    attempt.startingHeadCommit ?? fallbackStartingHeadCommit;
  if (startingHeadCommit) {
    const changedResult = await runGit(stellaAppDir, [
      "diff",
      "--name-only",
      startingHeadCommit,
      "HEAD",
    ]);
    if (changedResult.exitCode === 0) {
      for (const filePath of parseGitNameList(changedResult.stdout)) {
        changedFiles.add(filePath);
      }
    }
  }
  return [...changedFiles];
};

/**
 * Finish the reload half of an install-update-agent attempt whose original run
 * did not complete a host transition. The ordinary agent path owns its
 * self-mod lifecycle; its transitioned run id prevents a second morph here.
 */
const finalizeRecoveredAgentDesktopUpdate = async (args: {
  stellaAppDir: string;
  runner: StellaHostRunner;
  reacquireRunner?: ReacquireRunner | undefined;
  attempt: UpdateAttemptSnapshot;
  fallbackStartingHeadCommit: string | null;
  targetCommit: string;
  releaseTag: string | null;
}): Promise<void> => {
  const changedFiles = await listRecoveredAgentChangedFiles(
    args.stellaAppDir,
    args.attempt,
    args.fallbackStartingHeadCommit,
  );
  if (changedFiles.length === 0) return;

  const runId = `desktop-update-agent-recovery:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  try {
    await withDesktopUpdateTimeout(
      "agent-recovery.begin-external-self-mod",
      UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
      args.runner.beginExternalSelfMod({
        runId,
        paths: expandExternalSelfModPaths(changedFiles),
      }),
      {
        runId,
        releaseTag: args.releaseTag ?? undefined,
        targetCommit: shortCommit(args.targetCommit),
        changedFileCount: changedFiles.length,
      },
    );
    hmrRunStarted = true;
    const { reloaded } = await finishUpdateSelfModRun({
      runner: args.runner,
      reacquireRunner: args.reacquireRunner,
      runId,
      paths: changedFiles,
      logScope: "agent-recovery",
      logFields: {
        runId,
        releaseTag: args.releaseTag ?? undefined,
        targetCommit: shortCommit(args.targetCommit),
        changedFileCount: changedFiles.length,
      },
    });
    hmrRunStarted = false;
    if (!reloaded) {
      throw new Error(
        "Stella applied the recovered update on disk, but could not reload the running app onto it.",
      );
    }
    logDesktopUpdateProcess("desktop-update.agent-recovery.reload-complete", {
      runId,
      releaseTag: args.releaseTag ?? undefined,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: changedFiles.length,
    });
  } catch (error) {
    if (hmrRunStarted) {
      await args.runner
        .finishExternalSelfMod({ runId, succeeded: false })
        .catch(() => undefined);
    }
    throw error;
  }
};

export const recordAppliedDesktopUpdate = async (args: {
  stellaAppDir: string;
  runner: StellaHostRunner | null;
  reacquireRunner?: ReacquireRunner | undefined;
  commit: string;
  tag: string | null;
  mode?: RecordAppliedCommitMode | undefined;
  startingHeadCommit?: string | null | undefined;
  agentRunId?: string | null | undefined;
}): Promise<InstallManifestSnapshot | null> => {
  const startingHeadCommit = args.startingHeadCommit ?? null;
  if (args.mode === "release-pointer") {
    if (!startingHeadCommit) {
      throw new Error("startingHeadCommit is required.");
    }
    if (await hasMergeInProgress(args.stellaAppDir)) {
      throw new Error("A merge is still in progress in the install tree.");
    }
    if (await hasTrackedWorkingTreeChanges(args.stellaAppDir)) {
      throw new Error("The install tree still has tracked local changes.");
    }
    const currentHead = await readHeadCommit(args.stellaAppDir);
    if (currentHead === startingHeadCommit) {
      throw new Error(
        "The install-update agent did not create an update commit.",
      );
    }
  } else {
    const verification = await verifyMergeApplied(
      args.stellaAppDir,
      args.commit,
    );
    if (!verification.ok) {
      throw new Error(verification.reason);
    }
  }

  const attempt = (await readManifestWithRecovery(args.stellaAppDir))
    ?.lastUpdateAttempt;
  const isAgentAttempt =
    attempt != null &&
    attempt.mode === "agent" &&
    attempt.targetCommit === args.commit;
  const needsFinalizationCheck =
    isAgentAttempt && (Boolean(args.agentRunId) || attempt.status === "failed");
  if (needsFinalizationCheck) {
    const runner = args.runner ?? (await args.reacquireRunner?.());
    if (!runner) {
      throw new Error(
        "Stella runtime is not available to finish the recovered update reload.",
      );
    }
    const originalRunResult = args.agentRunId
      ? await runner.finishExternalSelfMod({
          runId: args.agentRunId,
          succeeded: true,
        })
      : null;
    if (originalRunResult?.transitioned !== true) {
      await finalizeRecoveredAgentDesktopUpdate({
        stellaAppDir: args.stellaAppDir,
        runner,
        reacquireRunner: args.reacquireRunner,
        attempt,
        fallbackStartingHeadCommit: startingHeadCommit,
        targetCommit: args.commit,
        releaseTag: args.tag,
      });
    }
  }

  return args.mode === "release-pointer"
    ? await writeAppliedReleasePointer(args.stellaAppDir, args.commit, args.tag)
    : await writeAppliedCommit(args.stellaAppDir, args.commit, args.tag);
};

type DesktopUpdateTransaction = {
  operationId: string;
  targetCommit: string;
  targetTag: string | null;
  startingHeadCommit: string | null;
};

const writeUpdateAttemptState = async (
  stellaAppDir: string,
  args: {
    status: "updating" | "failed";
    targetCommit: string;
    targetTag: string | null;
    reason?: string | null;
    operationId?: string | null;
    phase?: UpdateAttemptPhase | null;
    mode?: UpdateAttemptMode | null;
    recoveryAction?: UpdateAttemptRecoveryAction | null;
    startingHeadCommit?: string | null;
    changedFiles?: string[];
    ownedTempPaths?: string[];
    nativeHelpersManifestUrl?: string | null;
  },
): Promise<void> => {
  const manifestPath = manifestPathFromRoot(stellaAppDir);
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    parseManifest(raw);
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const recovered = await readManifestWithRecovery(stellaAppDir);
    if (recovered) {
      parsed = {
        version: recovered.version,
        platform: recovered.platform,
        installPath: recovered.installPath,
        installedAt: recovered.installedAt,
        desktopReleaseTag: recovered.desktopReleaseTag,
        desktopReleaseCommit: recovered.desktopReleaseCommit,
        desktopInstallBaseCommit: recovered.desktopInstallBaseCommit,
        installState: recovered.installState,
        lastUpdateAttempt: recovered.lastUpdateAttempt,
      };
    }
  }
  if (!parsed) return;

  const previousAttempt = parseUpdateAttemptSnapshot(parsed.lastUpdateAttempt);
  const now = new Date().toISOString();
  const operationId =
    args.operationId ?? previousAttempt?.operationId ?? randomUUID();
  const sameOperation =
    previousAttempt?.operationId === operationId &&
    previousAttempt.targetCommit === args.targetCommit;
  parsed.lastUpdateAttempt = {
    status: args.status,
    targetTag: args.targetTag,
    targetCommit: args.targetCommit,
    startedAt:
      args.status === "updating" && !sameOperation
        ? now
        : (previousAttempt?.startedAt ?? now),
    finishedAt: args.status === "failed" ? now : null,
    reason: args.reason ?? null,
    operationId,
    phase: args.phase ?? previousAttempt?.phase ?? null,
    mode: args.mode ?? previousAttempt?.mode ?? null,
    recoveryAction:
      args.recoveryAction ?? previousAttempt?.recoveryAction ?? null,
    startingHeadCommit:
      args.startingHeadCommit ?? previousAttempt?.startingHeadCommit ?? null,
    updatedAt: now,
    changedFiles: args.changedFiles ?? previousAttempt?.changedFiles ?? [],
    ownedTempPaths:
      args.ownedTempPaths ?? previousAttempt?.ownedTempPaths ?? [],
    nativeHelpersManifestUrl:
      args.nativeHelpersManifestUrl ??
      previousAttempt?.nativeHelpersManifestUrl ??
      null,
  };
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  parseManifest(next);
  await writeFileAtomic(manifestPath, next);
};

const writeDesktopUpdatePhase = async (
  stellaAppDir: string,
  transaction: DesktopUpdateTransaction | null | undefined,
  args: {
    phase: UpdateAttemptPhase;
    mode: UpdateAttemptMode;
    recoveryAction: UpdateAttemptRecoveryAction;
    changedFiles?: string[];
    ownedTempPaths?: string[];
    nativeHelpersManifestUrl?: string | null;
  },
) => {
  if (!transaction) return;
  await writeUpdateAttemptState(stellaAppDir, {
    status: "updating",
    targetCommit: transaction.targetCommit,
    targetTag: transaction.targetTag,
    operationId: transaction.operationId,
    startingHeadCommit: transaction.startingHeadCommit,
    phase: args.phase,
    mode: args.mode,
    recoveryAction: args.recoveryAction,
    changedFiles: args.changedFiles,
    ownedTempPaths: args.ownedTempPaths,
    nativeHelpersManifestUrl: args.nativeHelpersManifestUrl,
  }).catch((error) => {
    logDesktopUpdateWarn("desktop-update.attempt-state.phase-write-failed", {
      operationId: transaction.operationId,
      phase: args.phase,
      targetCommit: shortCommit(transaction.targetCommit),
      error,
    });
  });
};

const isSafeOwnedTempPath = (value: string): boolean =>
  Boolean(value) &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]+/).includes("..") &&
  (value === ".stella-native-helpers-download.tar.zst" ||
    /^\.stella-native-helpers-extract-[a-z0-9-]+-\*$/.test(value) ||
    /^\.stella-native-helpers-extract-[a-z0-9-]+-\d+$/.test(value) ||
    /^\.stella-native-helpers-files-[a-z0-9-]+-\*$/.test(value) ||
    /^\.stella-native-helpers-files-[a-z0-9-]+-\d+$/.test(value));

const cleanupOwnedUpdateTempPaths = async (
  stellaAppDir: string,
  ownedTempPaths: string[],
): Promise<string[]> => {
  const cleaned: string[] = [];
  for (const relativePath of ownedTempPaths) {
    if (!isSafeOwnedTempPath(relativePath)) continue;
    if (relativePath.endsWith("*")) {
      const prefix = relativePath.slice(0, -1);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(stellaAppDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        await fs.rm(path.join(stellaAppDir, entry), {
          recursive: true,
          force: true,
        });
        cleaned.push(entry);
      }
      continue;
    }
    await fs.rm(path.join(stellaAppDir, relativePath), {
      recursive: true,
      force: true,
    });
    cleaned.push(relativePath);
  }
  return cleaned;
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
  const bytes = await withDownloadRetries(args.label, ref.url, async () => {
    const response = await fetch(ref.url);
    if (!response.ok) {
      const message = `${args.label} download failed (${response.status}).`;
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableDownloadError(message, response.status);
      }
      throw new Error(message);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== ref.sizeBytes) {
      throw new RetryableDownloadError(
        `${args.label} size did not match the release.`,
      );
    }
    return bytes;
  });
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
  const response = await withDownloadRetries(
    "Desktop release manifest",
    url,
    async () => {
      const next = await fetch(url);
      if (!next.ok && isRetryableHttpStatus(next.status)) {
        throw new RetryableDownloadError(
          `Desktop release manifest download failed (${next.status}).`,
          next.status,
        );
      }
      return next;
    },
  );
  if (!response.ok) {
    return null;
  }
  const manifest = (await response.json()) as unknown;
  return sourceHistoryRefFromDesktopReleaseManifest(manifest, {
    targetCommit: args.targetCommit,
  });
};

const createOfficialSourceHistoryReconciler = (
  options: UpdatesHandlersOptions,
) => {
  const inFlight = new Map<
    string,
    Promise<OfficialSourceHistoryRecordResult>
  >();

  const resolveInstalledRelease = async (args?: {
    targetCommit?: string | null;
    releaseTag?: string | null;
    sourceHistoryRef?: DesktopReleaseSourceHistoryRef | null;
  }): Promise<{
    targetCommit: string;
    releaseTag: string;
    sourceHistoryRef: DesktopReleaseSourceHistoryRef | null;
  } | null> => {
    const targetCommit = asString(args?.targetCommit);
    const releaseTag = asString(args?.releaseTag);
    if (targetCommit && releaseTag) {
      let sourceHistoryRef = args?.sourceHistoryRef ?? null;
      if (!sourceHistoryRef) {
        const stellaAppDir = options.getStellaAppDir();
        if (stellaAppDir) {
          const release = await readReleaseManifest(stellaAppDir);
          if (release.commit === targetCommit && release.tag === releaseTag) {
            sourceHistoryRef = release.sourceHistoryRef;
          }
        }
      }
      return {
        targetCommit,
        releaseTag,
        sourceHistoryRef,
      };
    }

    const stellaAppDir = options.getStellaAppDir();
    if (!stellaAppDir) {
      return null;
    }
    const release = await readReleaseManifest(stellaAppDir);
    if (!release.commit || !release.tag) {
      return null;
    }
    return {
      targetCommit: release.commit,
      releaseTag: release.tag,
      sourceHistoryRef: release.sourceHistoryRef,
    };
  };

  const waitForReadyRunner = async (fields: LogFields) => {
    let runner = options.getStellaHostRunner?.() ?? null;
    if (!runner) {
      runner = await waitForConnectedRunner(
        () => options.getStellaHostRunner?.() ?? null,
        {
          timeoutMs: UPDATE_SOURCE_HISTORY_TIMEOUT_MS,
          unavailableMessage: "Runtime not available.",
          ...(options.onStellaHostRunnerChanged
            ? { onRunnerChanged: options.onStellaHostRunnerChanged }
            : {}),
        },
      );
    }

    await withDesktopUpdateTimeout(
      "official.wait-runtime-ready",
      UPDATE_SOURCE_HISTORY_TIMEOUT_MS,
      runner.waitUntilReady(UPDATE_SOURCE_HISTORY_TIMEOUT_MS),
      fields,
    );
    return runner;
  };

  const record = async (args?: {
    targetCommit?: string | null;
    releaseTag?: string | null;
    sourceHistoryRef?: DesktopReleaseSourceHistoryRef | null;
    reason?: string;
  }): Promise<OfficialSourceHistoryRecordResult> => {
    const release = await resolveInstalledRelease(args);
    if (!release) {
      logDesktopUpdateWarn("desktop-update.record-source-history.unavailable", {
        reason: args?.reason ?? "installed-release-unavailable",
      });
      return { ok: false, reason: "installed-release-unavailable" };
    }

    const key = `${release.targetCommit}:${release.releaseTag}:${release.sourceHistoryRef?.sha256 ?? "manifest"}`;
    const existing = inFlight.get(key);
    if (existing) {
      return await existing;
    }

    const promise = (async (): Promise<OfficialSourceHistoryRecordResult> => {
      const startedAt = Date.now();
      const reason = args?.reason ?? "manual";
      const baseFields = {
        releaseTag: release.releaseTag,
        targetCommit: shortCommit(release.targetCommit),
        reason,
      };
      logDesktopUpdateProcess("desktop-update.record-source-history.start", {
        ...baseFields,
        hasSourceHistoryRef: Boolean(release.sourceHistoryRef),
      });

      let runner: StellaHostRunner;
      try {
        runner = await waitForReadyRunner(baseFields);
      } catch {
        logDesktopUpdateWarn(
          "desktop-update.record-source-history.unavailable",
          {
            ...baseFields,
            elapsedMs: Date.now() - startedAt,
            reason: "runtime-unavailable",
          },
        );
        return { ok: false, reason: "runtime-unavailable" };
      }

      const existing = await withDesktopUpdateTimeout(
        "official.check-history",
        UPDATE_SOURCE_HISTORY_TIMEOUT_MS,
        runner.hasSourceRevisionForCommit(release.targetCommit),
        baseFields,
      ).catch((error) => {
        logDesktopUpdateWarn(
          "desktop-update.record-source-history.check-failed",
          {
            ...baseFields,
            error,
          },
        );
        return null;
      });
      if (existing?.exists) {
        const revisionId = existing.revisionId ?? `git:${release.targetCommit}`;
        logDesktopUpdateProcess(
          "desktop-update.record-source-history.skipped",
          {
            ...baseFields,
            revisionId,
            elapsedMs: Date.now() - startedAt,
            reason: "already-recorded",
          },
        );
        return { ok: true, revisionId };
      }

      let sourceHistoryRef = release.sourceHistoryRef;
      if (!sourceHistoryRef) {
        sourceHistoryRef = await fetchDesktopReleaseSourceHistoryRef({
          releaseTag: release.releaseTag,
          targetCommit: release.targetCommit,
        });
      }
      if (!sourceHistoryRef) {
        logDesktopUpdateWarn(
          "desktop-update.record-source-history.unavailable",
          {
            ...baseFields,
            elapsedMs: Date.now() - startedAt,
            reason: "source-history-unavailable",
          },
        );
        return { ok: false, reason: "source-history-unavailable" };
      }

      try {
        const sourcePack =
          await fetchDesktopSourceHistoryPack(sourceHistoryRef);
        await withDesktopUpdateTimeout(
          "official.record-history",
          UPDATE_SOURCE_HISTORY_TIMEOUT_MS,
          recordDesktopUpdateSourceHistory(runner, {
            sourcePack,
            releaseTag: release.releaseTag,
            targetCommit: release.targetCommit,
            origin: "official",
          }),
          baseFields,
        );
        logDesktopUpdateProcess("desktop-update.record-source-history.done", {
          ...baseFields,
          revisionId: sourcePack.revisionId,
          elapsedMs: Date.now() - startedAt,
        });
        return { ok: true, revisionId: sourcePack.revisionId };
      } catch (error) {
        logDesktopUpdateError(
          "desktop-update.record-source-history.failed",
          error,
          {
            ...baseFields,
            elapsedMs: Date.now() - startedAt,
          },
        );
        throw error;
      }
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return await promise;
  };

  const schedule = (
    reason: string,
    args?: {
      targetCommit?: string | null;
      releaseTag?: string | null;
      sourceHistoryRef?: DesktopReleaseSourceHistoryRef | null;
    },
    opts?: { delayMs?: number },
  ) => {
    // Concurrent/duplicate scheduled records are deduped by the inFlight key in
    // record(), so a delayed timer that overlaps a later trigger is harmless.
    const timer = setTimeout(() => {
      void record({ ...(args ?? {}), reason }).catch(() => undefined);
    }, opts?.delayMs ?? 0);
    timer.unref?.();
  };

  return { record, schedule };
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

export type DesktopUpdateRecoveryResult =
  | { status: "none" }
  | {
      status: "completed";
      reason: string;
      manifest: InstallManifestSnapshot | null;
      cleanedTempPaths: string[];
    }
  | {
      status: "discarded";
      reason: string;
      cleanedTempPaths: string[];
      rollback: DesktopUpdateRollbackResult | null;
    }
  | {
      status: "needs-agent";
      reason: string;
      cleanedTempPaths: string[];
    }
  | {
      status: "failed";
      reason: string;
      cleanedTempPaths: string[];
    };

const readCommitSubjectsSince = async (
  stellaAppDir: string,
  startingHeadCommit: string,
): Promise<string[] | null> => {
  const result = await runGit(stellaAppDir, [
    "log",
    "--format=%s",
    `${startingHeadCommit}..HEAD`,
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const updateAttemptFailedReason = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const recoverInterruptedDesktopUpdate = async (
  stellaAppDir: string,
  options?: {
    refreshNativeHelpers?: (args: {
      stellaAppDir: string;
      releaseTag: string | null;
      manifestUrl: string | null;
      attempt: UpdateAttemptSnapshot;
    }) => Promise<void>;
    runDependencyInstall?: (args: {
      stellaAppDir: string;
      changedFiles: string[];
      releaseTag: string | null;
      attempt: UpdateAttemptSnapshot;
    }) => Promise<void>;
  },
): Promise<DesktopUpdateRecoveryResult> => {
  const manifest = await readManifestWithRecovery(stellaAppDir);
  const attempt = manifest?.lastUpdateAttempt;
  if (!attempt || attempt.status !== "updating") {
    return { status: "none" };
  }

  const platformKey = nativeHelperPlatformKey();
  const ownedTempPaths =
    attempt.ownedTempPaths.length > 0
      ? attempt.ownedTempPaths
      : nativeHelperTempPathPatterns(platformKey);
  const cleanedTempPaths = await cleanupOwnedUpdateTempPaths(
    stellaAppDir,
    ownedTempPaths,
  );
  const failAttempt = async (
    reason: string,
  ): Promise<DesktopUpdateRecoveryResult> => {
    await writeUpdateAttemptState(stellaAppDir, {
      status: "failed",
      targetCommit: attempt.targetCommit,
      targetTag: attempt.targetTag,
      operationId: attempt.operationId,
      phase: attempt.phase,
      mode: attempt.mode,
      recoveryAction: attempt.recoveryAction,
      startingHeadCommit: attempt.startingHeadCommit,
      changedFiles: attempt.changedFiles,
      ownedTempPaths,
      nativeHelpersManifestUrl: attempt.nativeHelpersManifestUrl,
      reason,
    });
    return { status: "failed", reason, cleanedTempPaths };
  };

  if (await hasMergeInProgress(stellaAppDir)) {
    const reason =
      "A desktop update was interrupted while a Git merge was in progress; the install-update agent must inspect or abort it.";
    await writeUpdateAttemptState(stellaAppDir, {
      status: "failed",
      targetCommit: attempt.targetCommit,
      targetTag: attempt.targetTag,
      operationId: attempt.operationId,
      phase: attempt.phase ?? "git-merge",
      mode: attempt.mode ?? "git",
      recoveryAction: "needs-agent",
      startingHeadCommit: attempt.startingHeadCommit,
      changedFiles: attempt.changedFiles,
      ownedTempPaths,
      nativeHelpersManifestUrl: attempt.nativeHelpersManifestUrl,
      reason,
    });
    return { status: "needs-agent", reason, cleanedTempPaths };
  }

  const refresh = async () => {
    if (options?.refreshNativeHelpers) {
      await options.refreshNativeHelpers({
        stellaAppDir,
        releaseTag: attempt.targetTag,
        manifestUrl: attempt.nativeHelpersManifestUrl,
        attempt,
      });
      return;
    }
    await refreshNativeHelpers(stellaAppDir, attempt.targetTag ?? undefined, [], {
      manifestUrl: attempt.nativeHelpersManifestUrl ?? undefined,
    });
  };

  const runDependencyInstall = async () => {
    if (!storePublishTouchesDependencyFiles(attempt.changedFiles)) return;
    if (options?.runDependencyInstall) {
      await options.runDependencyInstall({
        stellaAppDir,
        changedFiles: attempt.changedFiles,
        releaseTag: attempt.targetTag,
        attempt,
      });
      return;
    }
    await runDesktopUpdateDependencyInstall({
      stellaAppDir,
      changedFiles: attempt.changedFiles,
      runId: `desktop-update-recovery:${attempt.operationId ?? Date.now()}`,
      releaseTag: attempt.targetTag ?? "unknown",
    });
  };

  const completeGitAncestryUpdate = async (reason: string) => {
    await runDependencyInstall();
    await refresh();
    await writeUpdateAttemptState(stellaAppDir, {
      status: "updating",
      targetCommit: attempt.targetCommit,
      targetTag: attempt.targetTag,
      operationId: attempt.operationId,
      phase: "record-complete",
      mode: attempt.mode ?? "git",
      recoveryAction: "resume",
      startingHeadCommit: attempt.startingHeadCommit,
      changedFiles: attempt.changedFiles,
      ownedTempPaths,
      nativeHelpersManifestUrl: attempt.nativeHelpersManifestUrl,
    });
    const nextManifest = await writeAppliedCommit(
      stellaAppDir,
      attempt.targetCommit,
      attempt.targetTag,
    );
    return {
      status: "completed" as const,
      reason,
      manifest: nextManifest,
      cleanedTempPaths,
    };
  };

  const targetIsAncestor = await runGit(stellaAppDir, [
    "merge-base",
    "--is-ancestor",
    attempt.targetCommit,
    "HEAD",
  ]);
  if (targetIsAncestor.exitCode === 0) {
    try {
      return await completeGitAncestryUpdate(
        "Interrupted desktop update had already landed in Git; refreshed helpers and recorded completion.",
      );
    } catch (error) {
      return await failAttempt(
        updateAttemptFailedReason(
          error,
          "Interrupted desktop update could not be completed during recovery.",
        ),
      );
    }
  }

  const startingHeadCommit = attempt.startingHeadCommit;
  const currentHead = await readHeadCommit(stellaAppDir).catch(() => null);
  if (
    startingHeadCommit &&
    currentHead &&
    currentHead !== startingHeadCommit &&
    attempt.mode === "source-pack"
  ) {
    const subjects = await readCommitSubjectsSince(
      stellaAppDir,
      startingHeadCommit,
    );
    const owned =
      subjects &&
      subjects.length > 0 &&
      subjects.every(updateCommitSubjectPolicy(attempt.targetTag));
    if (owned) {
      try {
        await runDependencyInstall();
        await refresh();
        await writeUpdateAttemptState(stellaAppDir, {
          status: "updating",
          targetCommit: attempt.targetCommit,
          targetTag: attempt.targetTag,
          operationId: attempt.operationId,
          phase: "record-complete",
          mode: "source-pack",
          recoveryAction: "resume",
          startingHeadCommit,
          changedFiles: attempt.changedFiles,
          ownedTempPaths,
          nativeHelpersManifestUrl: attempt.nativeHelpersManifestUrl,
        });
        const nextManifest = await writeAppliedReleasePointer(
          stellaAppDir,
          attempt.targetCommit,
          attempt.targetTag,
        );
        return {
          status: "completed",
          reason:
            "Interrupted source-pack update had already created an owned update commit; refreshed helpers and recorded completion.",
          manifest: nextManifest,
          cleanedTempPaths,
        };
      } catch (error) {
        return await failAttempt(
          updateAttemptFailedReason(
            error,
            "Interrupted source-pack update could not be completed during recovery.",
          ),
        );
      }
    }
    return await failAttempt(
      "HEAD moved after the interrupted update, but the commits do not match Stella's update ownership policy.",
    );
  }

  const shouldDiscard =
    attempt.recoveryAction === "discard" ||
    attempt.phase === "source-pack-write" ||
    attempt.phase === "source-pack-commit";
  if (shouldDiscard && startingHeadCommit) {
    const rollback = await rollbackCanceledDesktopUpdate(stellaAppDir, {
      startingHeadCommit,
      releaseTag: attempt.targetTag,
      changedFiles: attempt.changedFiles,
    });
    const reason =
      rollback.status === "rolled-back"
        ? "Interrupted desktop update was discarded and owned partial changes were rolled back."
        : `Interrupted desktop update could not be discarded automatically: ${rollback.reason}`;
    await writeUpdateAttemptState(stellaAppDir, {
      status: "failed",
      targetCommit: attempt.targetCommit,
      targetTag: attempt.targetTag,
      operationId: attempt.operationId,
      phase: attempt.phase,
      mode: attempt.mode,
      recoveryAction: attempt.recoveryAction,
      startingHeadCommit,
      changedFiles: attempt.changedFiles,
      ownedTempPaths,
      nativeHelpersManifestUrl: attempt.nativeHelpersManifestUrl,
      reason,
    });
    return {
      status: rollback.status === "rolled-back" ? "discarded" : "failed",
      reason,
      cleanedTempPaths,
      rollback,
    };
  }

  if (attempt.phase === "agent-fallback") {
    const reason =
      "A desktop update fallback agent was interrupted before Stella could verify completion.";
    await writeUpdateAttemptState(stellaAppDir, {
      status: "failed",
      targetCommit: attempt.targetCommit,
      targetTag: attempt.targetTag,
      operationId: attempt.operationId,
      phase: "agent-fallback",
      mode: "agent",
      recoveryAction: "needs-agent",
      startingHeadCommit,
      changedFiles: attempt.changedFiles,
      ownedTempPaths,
      nativeHelpersManifestUrl: attempt.nativeHelpersManifestUrl,
      reason,
    });
    return { status: "needs-agent", reason, cleanedTempPaths };
  }

  return await failAttempt(
    "A desktop update was interrupted before it reached a resumable phase; try the update again.",
  );
};

export const writeAppliedReleaseManifest = async (
  stellaAppDir: string,
  commit: string,
  tag: string | null,
  options?: { releaseManifestBaseUrl?: string },
): Promise<boolean> => {
  if (!tag) return false;
  const url = desktopReleaseManifestUrl(tag, options?.releaseManifestBaseUrl);
  const response = await withDownloadRetries(
    "Desktop release manifest",
    url,
    async () => {
      const next = await fetch(url);
      if (!next.ok && isRetryableHttpStatus(next.status)) {
        throw new RetryableDownloadError(
          `Release manifest download failed (${next.status}).`,
          next.status,
        );
      }
      return next;
    },
  );
  if (!response.ok) {
    throw new Error(`Release manifest download failed (${response.status}).`);
  }
  const manifest = (await response.json()) as Record<string, unknown>;
  if (manifest.tag !== tag) {
    throw new Error("Release manifest tag did not match the applied release.");
  }
  if (manifest.commit !== commit) {
    throw new Error(
      "Release manifest commit did not match the applied release.",
    );
  }
  const schemaVersion = manifest.schemaVersion;
  if (typeof schemaVersion !== "number" || schemaVersion < 1) {
    throw new Error("Release manifest schemaVersion is invalid.");
  }
  await writeFileAtomic(
    releaseManifestPathFromRoot(stellaAppDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return true;
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
  stellaAppDir: string,
  stellaDataDir: string,
  runner: StellaHostRunner | null,
  args: {
    baseCommit: string;
    targetCommit: string;
    releaseTag: string;
    sourcePackRef: DesktopReleaseSourcePackRef;
    artifactRefs?: StellaReleaseArtifactRef[];
    transaction?: DesktopUpdateTransaction;
    reacquireRunner?: ReacquireRunner;
  },
): Promise<DesktopUpdateFastApplyResult> => {
  await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
    phase: "source-pack-preflight",
    mode: "source-pack",
    recoveryAction: "discard",
  });
  logDesktopUpdateProcess("desktop-update.source-pack.start", {
    releaseTag: args.releaseTag,
    baseCommit: shortCommit(args.baseCommit),
    targetCommit: shortCommit(args.targetCommit),
  });
  if (await hasMergeInProgress(stellaAppDir)) {
    logDesktopUpdateWarn("desktop-update.source-pack.needs-agent", {
      releaseTag: args.releaseTag,
      reason: "merge-in-progress",
    });
    return {
      status: "needs-agent",
      reason: "A merge is already in progress in the install tree.",
    };
  }

  const sourcePack = await fetchDesktopUpdateSourcePack(args.sourcePackRef);
  if (!desktopSourcePackMatchesBaseCommit(sourcePack, args.baseCommit)) {
    logDesktopUpdateWarn("desktop-update.source-pack.base-mismatch", {
      releaseTag: args.releaseTag,
      baseCommit: shortCommit(args.baseCommit),
      sourceBaseRevisionId: sourcePack.baseRevisionId,
    });
    return {
      status: "needs-agent",
      reason: `Desktop source pack starts at ${sourcePack.baseRevisionId}, but this install is based on git:${args.baseCommit}.`,
      changedFiles: [],
    };
  }
  if (!desktopSourcePackCanApplyLocally(sourcePack)) {
    const sourcePaths = sourcePack.changeSets.flatMap((changeSet) =>
      changeSet.changes.map((change) => change.path),
    );
    logDesktopUpdateWarn("desktop-update.source-pack.not-local", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: sourcePaths.length,
    });
    return {
      status: "needs-agent",
      reason:
        "Desktop source pack omits content needed for local apply; falling back to Git update.",
      changedFiles: sourcePaths,
    };
  }

  const preflight = await preflightSourcePackImport({
    repoRoot: stellaAppDir,
    sourcePack,
    inspectDirtyTree: async () => {
      const dirty = await hasTrackedWorkingTreeChanges(stellaAppDir);
      return dirty
        ? {
            dirty: true,
            reason: "The install tree has tracked local changes.",
          }
        : { dirty: false };
    },
    isPathTracked: async (sourcePath) => {
      const result = await runGit(stellaAppDir, [
        "ls-files",
        "--error-unmatch",
        "--",
        sourcePath,
      ]);
      return result.exitCode === 0;
    },
  });
  if (preflight.status === "needs-agent") {
    logDesktopUpdateWarn("desktop-update.source-pack.obstructed", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      reason: preflight.reason,
      changedFileCount: preflight.sourcePaths.length,
    });
    return {
      status: "needs-agent",
      reason: preflight.obstruction
        ? `${preflight.reason} Falling back to Git update.`
        : preflight.reason,
      changedFiles: preflight.sourcePaths,
    };
  }
  const recordSourceHistory = async (commitHash = args.targetCommit) => {
    if (!runner) return;
    await withDesktopUpdateTimeout(
      "source-pack.record-history",
      UPDATE_SOURCE_HISTORY_TIMEOUT_MS,
      recordDesktopUpdateSourceHistory(runner, {
        sourcePack,
        releaseTag: args.releaseTag,
        targetCommit: commitHash,
      }),
      {
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(commitHash),
      },
    ).catch((error) => {
      console.warn("[updates] Failed to record desktop source history:", error);
    });
  };

  if (preflight.status === "conflicts") {
    logDesktopUpdateWarn("desktop-update.source-pack.conflicts", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      appliedPathCount: preflight.sourceApply.appliedPaths.length,
      conflictCount: preflight.sourceApply.conflicts.length,
    });
    const conflictRoot = path.join(
      stellaDataDir,
      "raw",
      "desktop-updates",
      args.releaseTag.replace(/[^a-z0-9_.-]/gi, "_"),
    );
    const sourcePackFile = path.join(conflictRoot, "SOURCE_PACK.json");
    const conflictFile = path.join(conflictRoot, "SOURCE_PACK_CONFLICTS.json");
    const conflictPayload = {
      status: preflight.sourceApply.status,
      revisionId: preflight.sourceApply.revisionId,
      sourcePackFile,
      appliedPaths: preflight.sourceApply.appliedPaths,
      appliedChanges: buildSourcePackAppliedChangesForAgent(
        preflight.sourceApply,
      ),
      noopPaths: preflight.sourceApply.noopPaths,
      conflicts: preflight.sourceApply
        .conflicts satisfies StellaSourceApplyConflict[],
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
        headCommit: await readHeadCommit(stellaAppDir),
        changedFiles: preflight.sourcePaths,
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
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: preflight.sourcePaths,
      sourcePackFile,
      sourcePackConflictFile: conflictFile,
      ...(shouldInlineConflictJson ? { sourcePackConflictJson } : {}),
    };
  }

  if (preflight.sourceApply.appliedPaths.length === 0) {
    const manifestBefore = await readManifestWithRecovery(stellaAppDir).catch(
      () => null,
    );
    const alreadyLive =
      manifestBefore?.installState?.desktopReleaseCommit === args.targetCommit;
    logDesktopUpdateProcess("desktop-update.source-pack.noop", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      alreadyLive,
    });
    // The tree already matches the target. If the install was recorded
    // complete for this exact commit, the app already reloaded onto it and
    // there is nothing to do. Otherwise a previous attempt was interrupted
    // after writing files but before the reload — the disk is updated while
    // the running app is stale. Replay the self-mod reload cycle over the
    // pack's paths instead of fake-reporting success.
    let reloaded = alreadyLive;
    if (!alreadyLive && runner && preflight.sourcePaths.length > 0) {
      const resumeRunId = `desktop-update-source-pack-resume:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;
      try {
        await withDesktopUpdateTimeout(
          "source-pack.resume-begin-external-self-mod",
          UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
          runner.beginExternalSelfMod({
            runId: resumeRunId,
            paths: expandExternalSelfModPaths(preflight.sourcePaths),
          }),
          {
            runId: resumeRunId,
            releaseTag: args.releaseTag,
            targetCommit: shortCommit(args.targetCommit),
            changedFileCount: preflight.sourcePaths.length,
          },
        );
        ({ reloaded } = await finishUpdateSelfModRun({
          runner,
          reacquireRunner: args.reacquireRunner,
          runId: resumeRunId,
          paths: preflight.sourcePaths,
          logScope: "source-pack",
          logFields: {
            runId: resumeRunId,
            releaseTag: args.releaseTag,
            targetCommit: shortCommit(args.targetCommit),
          },
        }));
      } catch (error) {
        logDesktopUpdateError(
          "desktop-update.source-pack.resume-reload-failed",
          error,
          {
            runId: resumeRunId,
            releaseTag: args.releaseTag,
            targetCommit: shortCommit(args.targetCommit),
          },
        );
        await runner
          .finishExternalSelfMod({ runId: resumeRunId, succeeded: false })
          .catch(() => undefined);
        reloaded = false;
      }
    }
    await recordSourceHistory();
    await refreshNativeHelpers(stellaAppDir, args.releaseTag, args.artifactRefs, {
      transaction: args.transaction,
      mode: "source-pack",
      changedFiles: [],
    });
    if (!reloaded) {
      // Leave the attempt in its resumable phase: the update pill keeps
      // offering the update (retry replays the reload) and startup recovery
      // records completion once the app is actually running the new code.
      logDesktopUpdateWarn("desktop-update.source-pack.applied-without-reload", {
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
      });
      return {
        status: "applied",
        manifest: null,
        headCommit: await readHeadCommit(stellaAppDir),
        changedFiles: [],
        dependencyInstallRan: false,
        nativeHelpersRefreshed: true,
        reloaded: false,
      };
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "source-pack",
      recoveryAction: "resume",
      changedFiles: [],
    });
    const manifest = await writeAppliedReleasePointer(
      stellaAppDir,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: [],
      dependencyInstallRan: false,
      nativeHelpersRefreshed: true,
      reloaded: true,
    };
  }

  if (!runner) {
    return {
      status: "needs-agent",
      reason: "Stella runtime is not available for the update morph.",
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: preflight.sourceApply.appliedPaths,
    };
  }

  const runId = `desktop-update-source-pack:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  let sourcePackCommitLanded = false;
  try {
    await withDesktopUpdateTimeout(
      "source-pack.begin-external-self-mod",
      UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
      runner.beginExternalSelfMod({
        runId,
        paths: expandExternalSelfModPaths(preflight.sourceApply.appliedPaths),
      }),
      {
        runId,
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
        changedFileCount: preflight.sourceApply.appliedPaths.length,
      },
    );
    hmrRunStarted = true;
    logDesktopUpdateProcess("desktop-update.source-pack.write.start", {
      runId,
      releaseTag: args.releaseTag,
      changedFileCount: preflight.sourceApply.appliedPaths.length,
    });
    const sourceImportTouchesDependencies = storePublishTouchesDependencyFiles(
      preflight.sourceApply.appliedPaths,
    );
    if (sourceImportTouchesDependencies) {
      logDesktopUpdateProcess("desktop-update.dependencies.install.start", {
        runId,
        releaseTag: args.releaseTag,
      });
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "source-pack-write",
      mode: "source-pack",
      recoveryAction: "discard",
      changedFiles: preflight.sourceApply.appliedPaths,
    });
    const { dependencyInstallRan } = await applyCleanSourceImportToWorkingTree({
      repoRoot: stellaAppDir,
      sourcePaths: preflight.sourcePaths,
      sourceApply: preflight.sourceApply,
    });
    if (dependencyInstallRan) {
      logDesktopUpdateProcess("desktop-update.dependencies.install.done", {
        runId,
        releaseTag: args.releaseTag,
      });
    }
    logDesktopUpdateProcess("desktop-update.source-pack.write.done", {
      runId,
      releaseTag: args.releaseTag,
      changedFileCount: preflight.sourceApply.appliedPaths.length,
    });

    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "source-pack-commit",
      mode: "source-pack",
      recoveryAction: "resume",
      changedFiles: preflight.sourceApply.appliedPaths,
    });
    const addResult = await runGit(stellaAppDir, [
      "add",
      "-A",
      "--",
      ...preflight.sourceApply.appliedPaths,
    ]);
    if (addResult.exitCode !== 0) {
      throw new Error(
        gitFailureDetail(addResult, "Could not stage source-pack update."),
      );
    }
    const commitResult = await runGit(stellaAppDir, [
      "commit",
      "-m",
      `Update to ${args.releaseTag}`,
    ]);
    if (commitResult.exitCode !== 0) {
      throw new Error(
        gitFailureDetail(commitResult, "Could not commit source-pack update."),
      );
    }
    sourcePackCommitLanded = true;

    logDesktopUpdateProcess("desktop-update.source-pack.commit.done", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
    });

    await recordSourceHistory(await readHeadCommit(stellaAppDir));
    // Drive the reload morph BEFORE the slow native-helper refresh and before
    // recording completion: "complete" in the manifest must mean the running
    // app actually reloaded onto the new code, and finishing promptly shrinks
    // the window in which the update's own runtime changes can restart the
    // worker underneath this flow.
    const { reloaded } = await finishUpdateSelfModRun({
      runner,
      reacquireRunner: args.reacquireRunner,
      runId,
      paths: preflight.sourceApply.appliedPaths,
      logScope: "source-pack",
      logFields: {
        runId,
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
      },
    });
    hmrRunStarted = false;
    await refreshNativeHelpers(stellaAppDir, args.releaseTag, args.artifactRefs, {
      transaction: args.transaction,
      mode: "source-pack",
      changedFiles: preflight.sourceApply.appliedPaths,
    });
    if (!reloaded) {
      logDesktopUpdateWarn("desktop-update.source-pack.applied-without-reload", {
        runId,
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
      });
      return {
        status: "applied",
        manifest: null,
        headCommit: await readHeadCommit(stellaAppDir),
        changedFiles: preflight.sourceApply.appliedPaths,
        dependencyInstallRan,
        nativeHelpersRefreshed: true,
        reloaded: false,
      };
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "source-pack",
      recoveryAction: "resume",
      changedFiles: preflight.sourceApply.appliedPaths,
    });
    const manifest = await writeAppliedReleasePointer(
      stellaAppDir,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: preflight.sourceApply.appliedPaths,
      dependencyInstallRan,
      nativeHelpersRefreshed: true,
      reloaded: true,
    };
  } catch (error) {
    logDesktopUpdateError("desktop-update.source-pack.failed", error, {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      hmrRunStarted,
      transportClosed: isRuntimeTransportClosedError(error),
    });
    if (hmrRunStarted) {
      await runner
        .finishExternalSelfMod({ runId, succeeded: sourcePackCommitLanded })
        .catch(async () => {
          // The old transport may be gone (worker restarted mid-update); try
          // once more against the reconnected worker so the host-side
          // runtime-reload pause for this runId is not leaked forever.
          await args
            .reacquireRunner?.()
            .then((fresh) =>
              fresh.finishExternalSelfMod({
                runId,
                succeeded: sourcePackCommitLanded,
              }),
            )
            .catch(() => undefined);
        });
    }
    throw error;
  }
};

export const tryApplyCleanDesktopUpdate = async (
  stellaAppDir: string,
  stellaDataDir: string,
  runner: StellaHostRunner | null,
  args: {
    baseCommit: string;
    targetCommit: string;
    releaseTag: string;
    sourcePackRef?: DesktopReleaseSourcePackRef;
    artifactRefs?: StellaReleaseArtifactRef[];
    transaction?: DesktopUpdateTransaction;
    reacquireRunner?: ReacquireRunner;
  },
): Promise<DesktopUpdateFastApplyResult> => {
  logDesktopUpdateProcess("desktop-update.fast.start", {
    releaseTag: args.releaseTag,
    baseCommit: shortCommit(args.baseCommit),
    targetCommit: shortCommit(args.targetCommit),
    hasSourcePack: Boolean(args.sourcePackRef),
  });
  if (args.sourcePackRef) {
    try {
      const sourcePackResult = await tryApplySourcePackDesktopUpdate(
        stellaAppDir,
        stellaDataDir,
        runner,
        {
          targetCommit: args.targetCommit,
          releaseTag: args.releaseTag,
          baseCommit: args.baseCommit,
          sourcePackRef: args.sourcePackRef,
          ...(args.artifactRefs ? { artifactRefs: args.artifactRefs } : {}),
          ...(args.transaction ? { transaction: args.transaction } : {}),
          ...(args.reacquireRunner
            ? { reacquireRunner: args.reacquireRunner }
            : {}),
        },
      );
      if (
        sourcePackResult.status === "applied" ||
        Boolean(sourcePackResult.sourcePackConflictFile)
      ) {
        logDesktopUpdateProcess("desktop-update.fast.source-pack-result", {
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
          status: sourcePackResult.status,
          changedFileCount:
            sourcePackResult.status === "applied"
              ? sourcePackResult.changedFiles.length
              : (sourcePackResult.changedFiles?.length ?? 0),
        });
        return sourcePackResult;
      }
      logDesktopUpdateWarn("desktop-update.fast.source-pack-fallback", {
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
        reason: sourcePackResult.reason,
      });
    } catch (error) {
      console.warn(
        "[updates] Source-pack update path failed; not falling back to git:",
        error,
      );
      logDesktopUpdateError("desktop-update.fast.source-pack-failed", error, {
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
      });
      throw error;
    }
  }

  if (await hasMergeInProgress(stellaAppDir)) {
    logDesktopUpdateWarn("desktop-update.fast.needs-agent", {
      releaseTag: args.releaseTag,
      reason: "merge-in-progress",
    });
    return {
      status: "needs-agent",
      reason: "A merge is already in progress in the install tree.",
    };
  }

  await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
    phase: "git-fetch",
    mode: "git",
    recoveryAction: "discard",
  });
  logDesktopUpdateProcess("desktop-update.git.fetch.start", {
    releaseTag: args.releaseTag,
    targetCommit: shortCommit(args.targetCommit),
  });
  const fetchResult = await runGit(stellaAppDir, [
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
  logDesktopUpdateProcess("desktop-update.git.fetch.done", {
    releaseTag: args.releaseTag,
    targetCommit: shortCommit(args.targetCommit),
  });

  const alreadyApplied = await runGit(stellaAppDir, [
    "merge-base",
    "--is-ancestor",
    args.targetCommit,
    "HEAD",
  ]);
  if (alreadyApplied.exitCode === 0) {
    // HEAD already contains the target but the pointer may be behind (a
    // previous attempt was interrupted before recording completion). Only
    // treat the update as live when the manifest already says so; otherwise
    // report applied-but-not-reloaded so the caller stays honest about the
    // running code being stale until a reload/restart.
    const manifestBefore = await readManifestWithRecovery(stellaAppDir).catch(
      () => null,
    );
    const alreadyLive =
      manifestBefore?.installState?.desktopReleaseCommit === args.targetCommit;
    logDesktopUpdateProcess("desktop-update.git.already-applied", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      alreadyLive,
    });
    await refreshNativeHelpers(stellaAppDir, args.releaseTag, args.artifactRefs, {
      transaction: args.transaction,
      mode: "git",
      changedFiles: [],
    });
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "git",
      recoveryAction: "resume",
      changedFiles: [],
    });
    const manifest = await writeAppliedCommit(
      stellaAppDir,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: [],
      dependencyInstallRan: false,
      nativeHelpersRefreshed: true,
      reloaded: alreadyLive,
    };
  }

  const mergeTree = await runGit(stellaAppDir, [
    "merge-tree",
    "--write-tree",
    "HEAD",
    args.targetCommit,
  ]);
  if (mergeTree.exitCode !== 0) {
    logDesktopUpdateWarn("desktop-update.git.preflight-conflict", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
    });
    const conflictChangedResult = await runGit(stellaAppDir, [
      "diff",
      "--name-only",
      "HEAD",
      args.targetCommit,
    ]);
    const conflictChangedFiles =
      conflictChangedResult.exitCode === 0
        ? parseGitNameList(conflictChangedResult.stdout)
        : [];
    return {
      status: "needs-agent",
      reason: "Git reported merge conflicts.",
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: conflictChangedFiles,
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

  const changedResult = await runGit(stellaAppDir, [
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
  const dirtyFiles = await listTrackedWorkingTreeChanges(stellaAppDir);
  const overlappingDirtyFiles = findOverlappingRepoPaths(
    dirtyFiles,
    changedFiles,
  );
  if (overlappingDirtyFiles.length > 0) {
    logDesktopUpdateWarn("desktop-update.fast.needs-agent", {
      releaseTag: args.releaseTag,
      reason: "tracked-local-changes-overlap",
      dirtyFileCount: dirtyFiles.length,
      overlappingDirtyFileCount: overlappingDirtyFiles.length,
    });
    return {
      status: "needs-agent",
      reason:
        "The install tree has tracked local changes that overlap the desktop update.",
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles,
    };
  }
  if (dirtyFiles.length > 0) {
    logDesktopUpdateProcess("desktop-update.git.dirty-non-overlap", {
      releaseTag: args.releaseTag,
      dirtyFileCount: dirtyFiles.length,
      changedFileCount: changedFiles.length,
    });
  }
  const runId = `desktop-update-fast:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  let mergeLanded = false;

  try {
    if (changedFiles.length > 0) {
      if (!runner) {
        logDesktopUpdateWarn("desktop-update.fast.needs-agent", {
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
          reason: "runtime-unavailable-for-morph",
          changedFileCount: changedFiles.length,
        });
        return {
          status: "needs-agent",
          reason: "Stella runtime is not available for the update morph.",
          headCommit: await readHeadCommit(stellaAppDir),
          changedFiles,
        };
      }
      await withDesktopUpdateTimeout(
        "git.begin-external-self-mod",
        UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
        runner.beginExternalSelfMod({
          runId,
          paths: expandExternalSelfModPaths(changedFiles),
        }),
        {
          runId,
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
          changedFileCount: changedFiles.length,
        },
      );
      hmrRunStarted = true;
    }

    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "git-merge",
      mode: "git",
      recoveryAction: "resume",
      changedFiles,
    });
    logDesktopUpdateProcess("desktop-update.git.merge.start", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: changedFiles.length,
    });
    const mergeResult = await runGit(stellaAppDir, [
      "merge",
      "--no-edit",
      "-m",
      `Update to ${args.releaseTag}`,
      args.targetCommit,
    ]);
    if (mergeResult.exitCode !== 0) {
      await abortMergeIfNeeded(stellaAppDir);
      if (hmrRunStarted && runner) {
        await runner
          .finishExternalSelfMod({ runId, succeeded: false })
          .catch(() => undefined);
        hmrRunStarted = false;
      }
      logDesktopUpdateWarn("desktop-update.git.merge-needs-agent", {
        runId,
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
        changedFileCount: changedFiles.length,
      });
      return {
        status: "needs-agent",
        reason: gitFailureDetail(mergeResult, "Git could not merge cleanly."),
        changedFiles,
      };
    }
    mergeLanded = true;
    logDesktopUpdateProcess("desktop-update.git.merge.done", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: changedFiles.length,
    });

    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "dependency-install",
      mode: "git",
      recoveryAction: "resume",
      changedFiles,
    });
    const dependencyInstallRan = await runDesktopUpdateDependencyInstall({
      stellaAppDir,
      changedFiles,
      runId,
      releaseTag: args.releaseTag,
    });

    logDesktopUpdateProcess("desktop-update.fast.applied", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: changedFiles.length,
      dependencyInstallRan,
    });
    // Drive the reload morph BEFORE the native-helper refresh and before
    // recording completion — see the source-pack path for rationale.
    let reloaded = true;
    if (hmrRunStarted && runner) {
      ({ reloaded } = await finishUpdateSelfModRun({
        runner,
        reacquireRunner: args.reacquireRunner,
        runId,
        paths: changedFiles,
        logScope: "git",
        logFields: {
          runId,
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
        },
      }));
      hmrRunStarted = false;
    }
    await refreshNativeHelpers(stellaAppDir, args.releaseTag, args.artifactRefs, {
      transaction: args.transaction,
      mode: "git",
      changedFiles,
    });
    if (!reloaded) {
      logDesktopUpdateWarn("desktop-update.git.applied-without-reload", {
        runId,
        releaseTag: args.releaseTag,
        targetCommit: shortCommit(args.targetCommit),
      });
      return {
        status: "applied",
        manifest: null,
        headCommit: await readHeadCommit(stellaAppDir),
        changedFiles,
        dependencyInstallRan,
        nativeHelpersRefreshed: true,
        reloaded: false,
      };
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "git",
      recoveryAction: "resume",
      changedFiles,
    });
    const manifest = await writeAppliedCommit(
      stellaAppDir,
      args.targetCommit,
      args.releaseTag,
    );
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles,
      dependencyInstallRan,
      nativeHelpersRefreshed: true,
      reloaded: true,
    };
  } catch (error) {
    logDesktopUpdateError("desktop-update.fast.failed", error, {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      hmrRunStarted,
      mergeLanded,
      transportClosed: isRuntimeTransportClosedError(error),
    });
    if (hmrRunStarted && runner) {
      await runner
        .finishExternalSelfMod({ runId, succeeded: mergeLanded })
        .catch(async (finishError) => {
          console.warn(
            "[updates] Failed to finalize fast-update self-mod lifecycle:",
            finishError,
          );
          // Clear a leaked host-side reload pause if the worker restarted
          // underneath the update.
          await args
            .reacquireRunner?.()
            .then((fresh) =>
              fresh.finishExternalSelfMod({ runId, succeeded: mergeLanded }),
            )
            .catch(() => undefined);
        });
    }
    throw error;
  }
};

export const registerUpdatesHandlers = (options: UpdatesHandlersOptions) => {
  const officialSourceHistory = createOfficialSourceHistoryReconciler(options);
  const reacquireUpdateRunner: ReacquireRunner = async () => {
    const runner = await waitForConnectedRunner(
      () => options.getStellaHostRunner?.() ?? null,
      {
        timeoutMs: UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
        unavailableMessage:
          "Stella runtime did not reconnect during the update.",
        ...(options.onStellaHostRunnerChanged
          ? { onRunnerChanged: options.onStellaHostRunnerChanged }
          : {}),
      },
    );
    await runner.waitUntilReady(UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS);
    return runner;
  };
  options.onStellaHostRunnerChanged?.((runner) => {
    if (runner) {
      officialSourceHistory.schedule("runner-ready", undefined, {
        delayMs: OFFICIAL_SOURCE_HISTORY_STARTUP_DELAY_MS,
      });
    }
  });
  if (options.getStellaHostRunner?.()) {
    officialSourceHistory.schedule("runner-ready", undefined, {
      delayMs: OFFICIAL_SOURCE_HISTORY_STARTUP_DELAY_MS,
    });
  }

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
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) return null;
      await recoverInterruptedDesktopUpdate(stellaAppDir).catch((error) => {
        logDesktopUpdateError("desktop-update.recovery.failed", error);
      });
      return await readManifestWithRecovery(stellaAppDir);
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
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        throw new Error("Stella install directory is unavailable.");
      }
      const stellaDataDir = options.getStellaDataDir();
      if (!stellaDataDir) {
        throw new Error("Stella home directory is unavailable.");
      }
      const transaction: DesktopUpdateTransaction = {
        operationId: randomUUID(),
        targetCommit,
        targetTag: releaseTag,
        startingHeadCommit: await readHeadCommit(stellaAppDir).catch(
          () => null,
        ),
      };
      const startedAt = Date.now();
      await writeUpdateAttemptState(stellaAppDir, {
        status: "updating",
        targetCommit,
        targetTag: releaseTag,
        operationId: transaction.operationId,
        phase: "started",
        recoveryAction: "discard",
        startingHeadCommit: transaction.startingHeadCommit,
      }).catch((error) => {
        logDesktopUpdateWarn("desktop-update.attempt-state.write-start-failed", {
          releaseTag,
          targetCommit: shortCommit(targetCommit),
          error,
        });
      });
      logDesktopUpdateProcess("desktop-update.try-clean.start", {
        releaseTag,
        baseCommit: shortCommit(baseCommit),
        targetCommit: shortCommit(targetCommit),
        hasSourcePack: Boolean(payload.sourcePackRef),
        artifactRefCount: Array.isArray(payload.artifactRefs)
          ? payload.artifactRefs.length
          : 0,
      });
      // The update can restart the runtime worker underneath the flow (its
      // own runtime/ changes, or a concurrent self-mod apply). Give the flow
      // a way to reach the reconnected worker so it can recover instead of
      // failing after the tree was already updated.
      try {
        const result = await tryApplyCleanDesktopUpdate(
          stellaAppDir,
          stellaDataDir,
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
            transaction,
            reacquireRunner: reacquireUpdateRunner,
          },
        );
        if (result.status === "needs-agent") {
          await writeDesktopUpdatePhase(stellaAppDir, transaction, {
            phase: "agent-fallback",
            mode: "agent",
            recoveryAction: "needs-agent",
            changedFiles: result.changedFiles ?? [],
          });
        }
        if (result.status === "applied") {
          officialSourceHistory.schedule("clean-update-applied", {
            targetCommit,
            releaseTag,
          });
        }
        logDesktopUpdateProcess("desktop-update.try-clean.done", {
          releaseTag,
          targetCommit: shortCommit(targetCommit),
          elapsedMs: Date.now() - startedAt,
          status: result.status,
          changedFileCount:
            result.status === "applied"
              ? result.changedFiles.length
              : (result.changedFiles?.length ?? 0),
          ...(result.status === "applied" ? { reloaded: result.reloaded } : {}),
          ...(result.status === "needs-agent" ? { reason: result.reason } : {}),
        });
        return result;
      } catch (error) {
        await writeUpdateAttemptState(stellaAppDir, {
          status: "failed",
          targetCommit,
          targetTag: releaseTag,
          reason:
            error instanceof Error
              ? error.message
              : "Desktop update failed before it could be applied.",
        }).catch((writeError) => {
          logDesktopUpdateWarn("desktop-update.attempt-state.write-failed", {
            releaseTag,
            targetCommit: shortCommit(targetCommit),
            error: writeError,
          });
        });
        logDesktopUpdateError("desktop-update.try-clean.failed", error, {
          releaseTag,
          targetCommit: shortCommit(targetCommit),
          elapsedMs: Date.now() - startedAt,
        });
        throw error;
      }
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
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        throw new Error("Stella install directory is unavailable.");
      }
      const currentAttempt = (await readManifestWithRecovery(stellaAppDir))
        ?.lastUpdateAttempt;
      const transaction =
        currentAttempt?.status === "updating" &&
        currentAttempt.targetTag === releaseTag
          ? {
              operationId: currentAttempt.operationId ?? randomUUID(),
              targetCommit: currentAttempt.targetCommit,
              targetTag: currentAttempt.targetTag,
              startingHeadCommit: currentAttempt.startingHeadCommit,
            }
          : null;
      const result = await refreshNativeHelpers(
        stellaAppDir,
        releaseTag,
        Array.isArray(payload.artifactRefs) ? payload.artifactRefs : undefined,
        {
          transaction,
          mode: currentAttempt?.mode ?? "native-helpers",
          changedFiles: currentAttempt?.changedFiles ?? [],
        },
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
      return await officialSourceHistory.record({
        targetCommit,
        releaseTag,
        sourceHistoryRef: payload?.sourceHistoryRef ?? null,
        reason: "ipc",
      });
    },
  );

  ipcMain.handle(
    IPC_UPDATES_ROLLBACK_CANCELED,
    async (
      event,
      payload: {
        startingHeadCommit?: string;
        releaseTag?: string;
        changedFiles?: string[];
      },
    ): Promise<DesktopUpdateRollbackResult> => {
      if (
        !options.assertPrivilegedSender(event, IPC_UPDATES_ROLLBACK_CANCELED)
      ) {
        throw new Error(
          "Blocked untrusted updates:rollbackCanceledUpdate request.",
        );
      }
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        throw new Error("Stella install directory is unavailable.");
      }
      const startingHeadCommit = asString(payload?.startingHeadCommit);
      if (!startingHeadCommit) {
        throw new Error("startingHeadCommit is required.");
      }
      const releaseTag = asString(payload?.releaseTag);
      const changedFiles = Array.isArray(payload?.changedFiles)
        ? payload.changedFiles.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      try {
        return await rollbackCanceledDesktopUpdate(stellaAppDir, {
          startingHeadCommit,
          releaseTag,
          changedFiles,
        });
      } catch (error) {
        logDesktopUpdateError("desktop-update.rollback.failed", error, {
          releaseTag,
          startingHeadCommit: shortCommit(startingHeadCommit),
          changedFileCount: changedFiles.length,
        });
        throw error;
      }
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
        agentRunId?: string;
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
      const agentRunId = asString(payload?.agentRunId);
      const stellaAppDir = options.getStellaAppDir();
      if (!stellaAppDir) {
        throw new Error("Stella install directory is unavailable.");
      }
      try {
        if (payload?.mode === "release-pointer") {
          const startingHeadCommit = asString(payload.startingHeadCommit);
          if (!startingHeadCommit) {
            throw new Error("startingHeadCommit is required.");
          }
          const manifest = await recordAppliedDesktopUpdate({
            stellaAppDir,
            runner: null,
            reacquireRunner: reacquireUpdateRunner,
            commit,
            tag,
            mode: "release-pointer",
            startingHeadCommit,
            agentRunId,
          });
          officialSourceHistory.schedule("applied-commit-recorded", {
            targetCommit: commit,
            releaseTag: tag,
          });
          return manifest;
        }
        const manifest = await recordAppliedDesktopUpdate({
          stellaAppDir,
          runner: null,
          reacquireRunner: reacquireUpdateRunner,
          commit,
          tag,
          agentRunId,
        });
        officialSourceHistory.schedule("applied-commit-recorded", {
          targetCommit: commit,
          releaseTag: tag,
        });
        return manifest;
      } catch (error) {
        await writeUpdateAttemptState(stellaAppDir, {
          status: "failed",
          targetCommit: commit,
          targetTag: tag,
          reason:
            error instanceof Error
              ? error.message
              : "Stella could not verify the update completed.",
        }).catch((writeError) => {
          logDesktopUpdateWarn("desktop-update.attempt-state.write-failed", {
            tag: tag ?? undefined,
            commit: shortCommit(commit),
            error: writeError,
          });
        });
        throw error;
      }
    },
  );
};
