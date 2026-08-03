/**
 * IPC for desktop update tracking and the clean-merge fast path.
 *
 * The launcher writes `stella-install.json` to the install directory after
 * setup. We surface two read/write helpers here:
 *
 *   - `updates:getInstallManifest` — return the parsed manifest so the
 *     renderer can compare its `desktopReleaseCommit` against the
 *     reactive `currentDesktopRelease` Convex query.
 *   - `updates:tryApplyCleanUpdate` — fetch the exact published commit,
 *     fast-forward an unchanged clone, merge local commits when Git can do so
 *     cleanly, and send only real conflicts to the install-update agent.
 *   - `updates:recordAppliedCommit` — verify against the local git tree
 *     that the install-update agent actually landed the target commit,
 *     then overwrite the manifest's `desktopReleaseCommit`. The agent's
 *     self-reported "completed" outcome is not trusted: the published commit
 *     must be in Git ancestry with no merge in progress.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setupGitEnvironment } from "../../../runtime/git-environment.js";
import {
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
  IPC_UPDATES_REFRESH_NATIVE_HELPERS,
  IPC_UPDATES_ROLLBACK_CANCELED,
  IPC_UPDATES_TRY_APPLY_CLEAN,
} from "../../src/shared/contracts/ipc-channels.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { StellaReleaseArtifactRef } from "../../../runtime/contracts/index.js";
import { rollbackGitChangesSince } from "../../../runtime/kernel/self-mod/git/revert.js";
import { isRuntimeUnavailableError } from "../../../runtime/protocol/rpc-peer.js";
import {
  STORE_PUBLISH_DEPENDENCY_FILE_NAMES,
  runStorePublishDependencyInstall,
  storePublishTouchesDependencyFiles,
} from "../../../runtime/worker/store-source-pack-install.js";
import {
  getFileLogger,
  type LogFields,
} from "../../../runtime/observability/file-logger.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { invalidateNativeHelperPathCache } from "../native-helper-path.js";
import { activateStagedStellaBrowserBinaryForInstall } from "../utils/stella-browser-paths.js";

const INSTALL_MANIFEST_BASENAME = "stella-install.json";
const RELEASE_MANIFEST_BASENAME = "stella-release.json";
const DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers";
const DEFAULT_NATIVE_HELPERS_MANIFEST_URL = `${DEFAULT_NATIVE_HELPERS_PUBLIC_BASE_URL}/current.json`;
const MAX_STELLA_BROWSER_ARTIFACT_BYTES = 100 * 1024 * 1024;
const UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS = 120_000;
const UPDATE_DOWNLOAD_RETRY_DELAYS_MS = [750, 1_500, 3_000, 6_000];

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

const hashBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

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

export const nativeHelperPlatformKey = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => {
  if (platform === "win32" && arch === "x64") {
    return "win-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "linux-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
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
  | "git-fast-forward"
  | "git-fetch"
  | "git-merge"
  | "dependency-install"
  | "native-refresh"
  | "record-complete"
  | "agent-fallback";

export type UpdateAttemptMode = "git" | "native-helpers" | "agent";

export type UpdateAttemptRecoveryAction = "resume" | "discard" | "needs-agent";

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

const parseUpdateAttemptPhase = (value: unknown): UpdateAttemptPhase | null => {
  switch (value) {
    case "started":
    case "git-fast-forward":
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
};

const runGit = (cwd: string, args: string[]): Promise<GitRunResult> =>
  new Promise((resolve, reject) => {
    const { env, gitLocation } = setupGitEnvironment();
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
    (
      ref,
    ): ref is Extract<StellaReleaseArtifactRef, { kind: "native-helpers" }> =>
      ref.kind === "native-helpers" && ref.platform === platformKey,
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

const stellaBrowserBinaryName = (platformKey: string): string | null => {
  switch (platformKey) {
    case "darwin-arm64":
    case "darwin-x64":
    case "linux-arm64":
    case "linux-x64":
      return "stella-browser";
    case "win-x64":
      return "stella-browser.exe";
    default:
      return null;
  }
};

export const stageStellaBrowserUpdate = async (
  stellaAppDir: string,
  artifactRefs?: StellaReleaseArtifactRef[],
): Promise<string | null> => {
  const platformKey = nativeHelperPlatformKey();
  const ref = artifactRefs?.find(
    (candidate) =>
      candidate.kind === "stella-browser" && candidate.platform === platformKey,
  );
  if (!ref) return null;

  const binaryName = stellaBrowserBinaryName(platformKey);
  if (!binaryName) {
    throw new Error(
      `Unsupported Stella Browser update platform: ${platformKey}.`,
    );
  }
  const { asset } = ref;
  if (!/^https:\/\//i.test(asset.url)) {
    throw new Error("Stella Browser artifact URL is invalid.");
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(asset.sha256)) {
    throw new Error("Stella Browser artifact hash is invalid.");
  }
  if (
    !Number.isInteger(asset.sizeBytes) ||
    asset.sizeBytes <= 0 ||
    asset.sizeBytes > MAX_STELLA_BROWSER_ARTIFACT_BYTES
  ) {
    throw new Error("Stella Browser artifact size is invalid.");
  }

  const relativePath = path.posix.join(
    "desktop",
    "stella-browser",
    "out",
    platformKey,
    binaryName,
  );
  const binaryPath = path.join(stellaAppDir, ...relativePath.split("/"));
  const stagedPath = `${binaryPath}.update`;
  const installedBytes = await fs.readFile(binaryPath).catch(() => null);
  if (
    installedBytes &&
    hashBytes(installedBytes).toLowerCase() === asset.sha256.toLowerCase()
  ) {
    await fs.rm(stagedPath, { force: true }).catch(() => undefined);
    return null;
  }

  const bytes = await withDownloadRetries(
    "Stella Browser artifact",
    asset.url,
    async () => {
      const response = await fetch(asset.url);
      if (!response.ok) {
        const message = `Stella Browser artifact download failed (${response.status}).`;
        if (isRetryableHttpStatus(response.status)) {
          throw new RetryableDownloadError(message, response.status);
        }
        throw new Error(message);
      }
      const downloaded = new Uint8Array(await response.arrayBuffer());
      if (downloaded.byteLength !== asset.sizeBytes) {
        throw new RetryableDownloadError(
          "Stella Browser artifact size did not match the release.",
        );
      }
      return downloaded;
    },
  );
  if (hashBytes(bytes).toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error("Stella Browser artifact hash did not match the release.");
  }

  const tempPath = `${stagedPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(binaryPath), { recursive: true });
  try {
    await fs.writeFile(tempPath, bytes, { mode: 0o755 });
    if (process.platform !== "win32") await fs.chmod(tempPath, 0o755);
    await fs.rename(tempPath, stagedPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  return relativePath;
};

const discardStagedStellaBrowserUpdate = async (
  stellaAppDir: string,
  relativePath: string | null,
): Promise<void> => {
  if (!relativePath) return;
  const binaryPath = path.join(stellaAppDir, ...relativePath.split("/"));
  await fs.rm(`${binaryPath}.update`, { force: true }).catch(() => undefined);
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

const MAX_DESKTOP_SOURCE_HISTORY_BYTES = 10 * 1024 * 1024;

const parseGitNameList = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const parseGitNulList = (stdout: string): string[] =>
  stdout
    .split("\0")
    .map((entry) => entry.trim().replace(/\\/g, "/"))
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
  logScope: "git" | "agent-recovery";
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
      return (
        renameMarker >= 0 ? pathPart.slice(renameMarker + 4) : pathPart
      ).replace(/\\/g, "/");
    })
    .filter(Boolean);
};

type DesktopContentOverlay = {
  overlayPaths: string[];
  indexOverlayPaths: string[];
  workingTreeOverlayPaths: string[];
};

/**
 * Compare the install's actual tracked content with the published release it
 * currently represents. This deliberately does not inspect ancestry: source
 * installs use synthetic update commits, so ancestry can diverge while the
 * content is byte-for-byte the published base.
 */
export const inspectDesktopContentOverlay = async (
  stellaAppDir: string,
  baseCommit: string,
): Promise<DesktopContentOverlay> => {
  const indexResult = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "-z",
    baseCommit,
    "--",
  ]);
  if (indexResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(
        indexResult,
        "Could not compare the install index with its published release.",
      ),
    );
  }
  const workingResult = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "--",
  ]);
  if (workingResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(
        workingResult,
        "Could not compare the install working tree with its index.",
      ),
    );
  }
  const indexOverlayPaths = parseGitNulList(indexResult.stdout);
  const workingTreeOverlayPaths = parseGitNulList(workingResult.stdout);
  return {
    overlayPaths: [
      ...new Set([...indexOverlayPaths, ...workingTreeOverlayPaths]),
    ].sort(),
    indexOverlayPaths,
    workingTreeOverlayPaths,
  };
};

const listUpdaterOwnedPathsNotMatchingHead = async (
  stellaAppDir: string,
  ownedPaths: string[],
): Promise<string[]> => {
  const normalized = [
    ...new Set(ownedPaths.map((entry) => entry.replace(/\\/g, "/"))),
  ];
  if (normalized.length === 0) return [];
  const staged = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    ...normalized,
  ]);
  const working = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "-z",
    "--",
    ...normalized,
  ]);
  if (staged.exitCode !== 0 || working.exitCode !== 0) {
    throw new Error("Could not verify updater-owned paths against HEAD.");
  }
  return [
    ...new Set([
      ...parseGitNulList(staged.stdout),
      ...parseGitNulList(working.stdout),
    ]),
  ].sort();
};

export const reconcileUpdaterOwnedPaths = async (
  stellaAppDir: string,
  ownedPaths: string[],
): Promise<{ browserBinaryActivated: boolean }> => {
  const browserBinaryActivated =
    activateStagedStellaBrowserBinaryForInstall(stellaAppDir);
  const mismatchedPaths = await listUpdaterOwnedPathsNotMatchingHead(
    stellaAppDir,
    ownedPaths,
  );
  if (mismatchedPaths.length > 0) {
    throw new Error(
      `Updater-owned tracked paths do not match HEAD: ${mismatchedPaths.join(", ")}`,
    );
  }
  return { browserBinaryActivated };
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
    nativeHelpersManifestUrl: previousAttempt?.nativeHelpersManifestUrl ?? null,
  };
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  parseManifest(next);
  await writeFileAtomic(manifestPath, next);
  await writeAppliedReleaseManifest(stellaAppDir, commit, tag).catch(
    (error) => {
      logDesktopUpdateWarn("desktop-update.release-manifest.write-failed", {
        tag: tag ?? undefined,
        commit: shortCommit(commit),
        error,
      });
    },
  );
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
const verifyMergeAppliedOnce = async (
  stellaAppDir: string,
  targetCommit: string,
): Promise<VerifyResult & { retryable?: boolean }> => {
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
      retryable: true,
      reason:
        "A merge is still in progress in the install tree — Stella didn't finish applying the update.",
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        retryable: true,
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
  if (isAncestor.exitCode === 1) {
    // A real "not in HEAD's ancestry" answer from git. Still retryable at
    // the wrapper level: the applier's reset/merge may be landing this very
    // second (observed in the field — the verify raced a `git reset` that
    // completed within the same second and reported a false failure).
    return {
      ok: false,
      retryable: true,
      reason: `Stella could not confirm the update was applied. The update agent finished, but this install is still not on ${targetCommit.slice(0, 8)}. Please try Update again.`,
    };
  }
  if (isAncestor.exitCode !== 0) {
    // Not an ancestry answer at all — the git invocation itself failed
    // (index.lock contention with the install's auto-commit machinery,
    // missing object, etc.). Don't report this as "not on <commit>".
    return {
      ok: false,
      retryable: true,
      reason: `Stella could not verify the update: git exited ${isAncestor.exitCode}${isAncestor.stderr.trim() ? ` (${isAncestor.stderr.trim().slice(0, 200)})` : ""}. Please try Update again.`,
    };
  }
  const headRev = await runGit(stellaAppDir, ["rev-parse", "HEAD"]);
  if (headRev.exitCode !== 0) {
    return {
      ok: false,
      retryable: true,
      reason: "Could not read current HEAD after the update.",
    };
  }
  return { ok: true, headCommit: headRev.stdout.trim() };
};

const VERIFY_MERGE_APPLIED_ATTEMPTS = 4;
const VERIFY_MERGE_APPLIED_RETRY_DELAY_MS = 500;

/**
 * Retrying wrapper around {@link verifyMergeAppliedOnce}. The verify step
 * runs concurrently with the tail of the apply path (agent finalization,
 * startup recovery replay, the install's own auto-commits), so a transient
 * "not there yet" or a locked .git must not fail the update — re-check a
 * few times before reporting failure.
 */
export const verifyMergeApplied = async (
  stellaAppDir: string,
  targetCommit: string,
): Promise<VerifyResult> => {
  let last: VerifyResult & { retryable?: boolean } = {
    ok: false,
    reason: "Update verification did not run.",
  };
  for (let attempt = 0; attempt < VERIFY_MERGE_APPLIED_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, VERIFY_MERGE_APPLIED_RETRY_DELAY_MS),
      );
    }
    last = await verifyMergeAppliedOnce(stellaAppDir, targetCommit);
    if (last.ok || !last.retryable) {
      break;
    }
    logDesktopUpdateWarn("desktop-update.verify.retry", {
      attempt: attempt + 1,
      commit: shortCommit(targetCommit),
      reason: last.reason,
    });
  }
  return last.ok
    ? { ok: true, headCommit: last.headCommit }
    : { ok: false, reason: last.reason };
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
    };
  } catch {
    return { tag: null, commit: null };
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
  startingHeadCommit?: string | null | undefined;
  agentRunId?: string | null | undefined;
}): Promise<InstallManifestSnapshot | null> => {
  const startingHeadCommit = args.startingHeadCommit ?? null;
  const verification = await verifyMergeApplied(args.stellaAppDir, args.commit);
  if (!verification.ok) {
    throw new Error(verification.reason);
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

  return await writeAppliedCommit(args.stellaAppDir, args.commit, args.tag);
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
    await refreshNativeHelpers(
      stellaAppDir,
      attempt.targetTag ?? undefined,
      [],
      {
        manifestUrl: attempt.nativeHelpersManifestUrl ?? undefined,
      },
    );
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
    const reconciliation = await reconcileUpdaterOwnedPaths(
      stellaAppDir,
      attempt.changedFiles,
    );
    if (reconciliation.browserBinaryActivated) {
      logDesktopUpdateProcess("desktop-update.recovery.browser-activated", {
        targetCommit: shortCommit(attempt.targetCommit),
        updaterOwnedPaths: attempt.changedFiles,
      });
    }
    await runDependencyInstall();
    await refresh();
    await reconcileUpdaterOwnedPaths(stellaAppDir, attempt.changedFiles);
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

  const shouldDiscard = attempt.recoveryAction === "discard";
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
): Promise<boolean> => {
  if (!tag) return false;
  const version = tag.startsWith("desktop-v")
    ? tag.slice("desktop-v".length)
    : tag;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(
      await fs.readFile(releaseManifestPathFromRoot(stellaAppDir), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    // A missing local release marker is recoverable from the applied commit.
  }
  const manifest = {
    ...existing,
    schemaVersion: 1,
    tag,
    version,
    commit,
    files:
      existing.files && typeof existing.files === "object"
        ? existing.files
        : {},
  };
  await writeFileAtomic(
    releaseManifestPathFromRoot(stellaAppDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return true;
};

const gitCommitExists = async (
  stellaAppDir: string,
  commit: string,
): Promise<boolean> => {
  const result = await runGit(stellaAppDir, [
    "cat-file",
    "-e",
    `${commit}^{commit}`,
  ]);
  return result.exitCode === 0;
};

const listUntrackedFiles = async (stellaAppDir: string): Promise<string[]> => {
  const result = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(result, "Could not inspect untracked install files."),
    );
  }
  return parseGitNulList(result.stdout);
};

const listIgnoredPaths = async (stellaAppDir: string): Promise<string[]> => {
  const result = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(result, "Could not inspect ignored install paths."),
    );
  }
  return parseGitNulList(result.stdout);
};

const topmostRepoPaths = (paths: string[]): string[] => {
  const sorted = [...new Set(paths)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return sorted.filter(
    (candidate, index) =>
      !sorted
        .slice(0, index)
        .some((parent) => repoPathOverlaps(parent, candidate)),
  );
};

type ContentLandingRecoverySnapshot = {
  recoveryRoot: string;
  recoveryRef: string;
  snapshotCommit: string;
  movedObstructions: Array<{ path: string; backupPath: string }>;
};

const createContentLandingRecoverySnapshot = async (args: {
  stellaAppDir: string;
  stellaDataDir: string;
  baseCommit: string;
  targetCommit: string;
  releaseTag: string;
  overlay: DesktopContentOverlay;
  obstructionPaths: string[];
}): Promise<ContentLandingRecoverySnapshot> => {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const recoveryRoot = path.join(
    args.stellaDataDir,
    "raw",
    "desktop-update-recovery",
    id,
  );
  await fs.mkdir(recoveryRoot, { recursive: true });

  const startingHead = await readHeadCommit(args.stellaAppDir);
  const stashResult = await runGit(args.stellaAppDir, [
    "stash",
    "create",
    `Stella desktop update recovery ${id}`,
  ]);
  if (stashResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(
        stashResult,
        "Could not snapshot the install before fast-forward.",
      ),
    );
  }
  const snapshotCommit = stashResult.stdout.trim() || startingHead;
  const recoveryRef = `refs/stella/update-recovery/${id}`;
  const refResult = await runGit(args.stellaAppDir, [
    "update-ref",
    recoveryRef,
    snapshotCommit,
  ]);
  if (refResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(
        refResult,
        "Could not preserve the pre-update recovery ref.",
      ),
    );
  }

  const movedObstructions: ContentLandingRecoverySnapshot["movedObstructions"] =
    [];
  const snapshot = {
    recoveryRoot,
    recoveryRef,
    snapshotCommit,
    movedObstructions,
  };

  try {
    for (const repoPath of topmostRepoPaths(args.obstructionPaths)) {
      const sourcePath = path.join(args.stellaAppDir, ...repoPath.split("/"));
      const backupPath = path.join(
        recoveryRoot,
        "obstructions",
        ...repoPath.split("/"),
      );
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      try {
        await fs.rename(sourcePath, backupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EXDEV") {
          await fs.cp(sourcePath, backupPath, { recursive: true });
          await fs.rm(sourcePath, { recursive: true, force: true });
        } else {
          throw error;
        }
      }
      movedObstructions.push({ path: repoPath, backupPath });
    }

    await fs.writeFile(
      path.join(recoveryRoot, "snapshot.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          releaseTag: args.releaseTag,
          baseCommit: args.baseCommit,
          targetCommit: args.targetCommit,
          startingHead,
          snapshotCommit,
          recoveryRef,
          overlay: args.overlay,
          movedObstructions,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return snapshot;
  } catch (error) {
    await restoreContentLandingObstructions(args.stellaAppDir, snapshot).catch(
      () => undefined,
    );
    throw error;
  }
};

const restoreContentLandingObstructions = async (
  stellaAppDir: string,
  snapshot: ContentLandingRecoverySnapshot,
): Promise<void> => {
  for (const entry of [...snapshot.movedObstructions].reverse()) {
    const restorePath = path.join(stellaAppDir, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.rm(restorePath, { recursive: true, force: true });
    try {
      await fs.rename(entry.backupPath, restorePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.cp(entry.backupPath, restorePath, { recursive: true });
        await fs.rm(entry.backupPath, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
  }
};

const isLegacyTrackedBrowserBinaryPath = (filePath: string): boolean =>
  /^desktop\/stella-browser\/bin\/stella-browser-(?:darwin|linux|win32)-/.test(
    filePath,
  );

const listLegacyBrowserPathsRemovedByTarget = async (
  stellaAppDir: string,
  targetCommit: string,
): Promise<string[]> => {
  const [trackedResult, targetResult] = await Promise.all([
    runGit(stellaAppDir, [
      "-c",
      "core.quotepath=false",
      "ls-files",
      "-z",
      "--",
      "desktop/stella-browser/bin",
    ]),
    runGit(stellaAppDir, [
      "-c",
      "core.quotepath=false",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      targetCommit,
      "--",
      "desktop/stella-browser/bin",
    ]),
  ]);
  if (trackedResult.exitCode !== 0 || targetResult.exitCode !== 0) return [];
  const targetPaths = new Set(parseGitNulList(targetResult.stdout));
  return parseGitNulList(trackedResult.stdout).filter(
    (filePath) =>
      isLegacyTrackedBrowserBinaryPath(filePath) && !targetPaths.has(filePath),
  );
};

/**
 * If the install's tracked content exactly matches its published base and
 * HEAD is an ancestor of the target, fast-forward to the published commit.
 */
const tryFastForwardCleanPublishedTree = async (
  stellaAppDir: string,
  stellaDataDir: string,
  runner: StellaHostRunner | null,
  args: {
    baseCommit: string;
    targetCommit: string;
    releaseTag: string;
    artifactRefs?: StellaReleaseArtifactRef[];
    transaction?: DesktopUpdateTransaction;
    reacquireRunner?: ReacquireRunner;
  },
): Promise<DesktopUpdateFastApplyResult | null> => {
  if (
    !(await gitCommitExists(stellaAppDir, args.baseCommit)) ||
    !(await gitCommitExists(stellaAppDir, args.targetCommit))
  ) {
    return null;
  }

  const overlay = await inspectDesktopContentOverlay(
    stellaAppDir,
    args.baseCommit,
  );
  const legacyBrowserPathsRemovedByTarget = new Set(
    await listLegacyBrowserPathsRemovedByTarget(
      stellaAppDir,
      args.targetCommit,
    ),
  );
  const migratingLegacyBrowserPaths = overlay.overlayPaths.filter(
    (filePath) =>
      isLegacyTrackedBrowserBinaryPath(filePath) &&
      legacyBrowserPathsRemovedByTarget.has(filePath),
  );
  const effectiveOverlayPaths = overlay.overlayPaths.filter(
    (filePath) => !migratingLegacyBrowserPaths.includes(filePath),
  );
  logDesktopUpdateProcess("desktop-update.content-overlay.inspected", {
    releaseTag: args.releaseTag,
    baseCommit: shortCommit(args.baseCommit),
    targetCommit: shortCommit(args.targetCommit),
    overlayPaths: overlay.overlayPaths,
    overlayPathCount: overlay.overlayPaths.length,
    effectiveOverlayPaths,
    effectiveOverlayPathCount: effectiveOverlayPaths.length,
    migratingLegacyBrowserPaths,
    indexOverlayPaths: overlay.indexOverlayPaths,
    workingTreeOverlayPaths: overlay.workingTreeOverlayPaths,
  });
  if (effectiveOverlayPaths.length > 0) return null;
  const canFastForward = await runGit(stellaAppDir, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    args.targetCommit,
  ]);
  if (canFastForward.exitCode !== 0) return null;

  const changedResult = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    args.baseCommit,
    args.targetCommit,
    "--",
  ]);
  if (changedResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(
        changedResult,
        "Could not inspect published desktop update changes.",
      ),
    );
  }
  const changedFiles = parseGitNulList(changedResult.stdout);
  const targetFilesResult = await runGit(stellaAppDir, [
    "-c",
    "core.quotepath=false",
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    args.targetCommit,
    "--",
    ...changedFiles,
  ]);
  if (targetFilesResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(
        targetFilesResult,
        "Could not inspect target paths before fast-forward.",
      ),
    );
  }
  const targetFiles = parseGitNulList(targetFilesResult.stdout);
  const [untrackedFiles, ignoredPaths] = await Promise.all([
    listUntrackedFiles(stellaAppDir),
    listIgnoredPaths(stellaAppDir),
  ]);
  const obstructingUntrackedFiles = findOverlappingRepoPaths(
    untrackedFiles,
    targetFiles,
  );
  const obstructingIgnoredPaths = findOverlappingRepoPaths(
    ignoredPaths,
    targetFiles,
  );
  const obstructionPaths = [
    ...new Set([...obstructingUntrackedFiles, ...obstructingIgnoredPaths]),
  ];
  const stagedBrowserPath = await stageStellaBrowserUpdate(
    stellaAppDir,
    args.artifactRefs,
  );
  const transitionPaths = stagedBrowserPath
    ? [...new Set([...changedFiles, stagedBrowserPath])]
    : changedFiles;

  if (transitionPaths.length > 0 && !runner) {
    await discardStagedStellaBrowserUpdate(stellaAppDir, stagedBrowserPath);
    return {
      status: "needs-agent",
      reason: "Stella runtime is not available for the update morph.",
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: transitionPaths,
    };
  }

  const runId = `desktop-update-git-fast-forward:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  let landed = false;
  try {
    if (runner && transitionPaths.length > 0) {
      await withDesktopUpdateTimeout(
        "git-fast-forward.begin-external-self-mod",
        UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
        runner.beginExternalSelfMod({
          runId,
          paths: expandExternalSelfModPaths(transitionPaths),
        }),
        {
          runId,
          releaseTag: args.releaseTag,
          changedFileCount: transitionPaths.length,
          changedFileScope: "release-update-files",
        },
      );
      hmrRunStarted = true;
    }

    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "git-fast-forward",
      mode: "git",
      recoveryAction: "resume",
      changedFiles: transitionPaths,
    });
    logDesktopUpdateProcess("desktop-update.git-fast-forward.start", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: transitionPaths.length,
      changedFileScope: "release-update-files",
    });
    const recoverySnapshot = await createContentLandingRecoverySnapshot({
      stellaAppDir,
      stellaDataDir,
      baseCommit: args.baseCommit,
      targetCommit: args.targetCommit,
      releaseTag: args.releaseTag,
      overlay,
      obstructionPaths,
    });
    logDesktopUpdateProcess("desktop-update.git-fast-forward.snapshot", {
      runId,
      releaseTag: args.releaseTag,
      recoveryRoot: recoverySnapshot.recoveryRoot,
      recoveryRef: recoverySnapshot.recoveryRef,
      snapshotCommit: shortCommit(recoverySnapshot.snapshotCommit),
      movedObstructionPaths: recoverySnapshot.movedObstructions.map(
        (entry) => entry.path,
      ),
      ignoredObstructionPaths: obstructingIgnoredPaths,
      untrackedObstructionPaths: obstructingUntrackedFiles,
    });
    const fastForwardResult = await runGit(stellaAppDir, [
      "merge",
      "--ff-only",
      args.targetCommit,
    ]);
    if (fastForwardResult.exitCode !== 0) {
      await restoreContentLandingObstructions(stellaAppDir, recoverySnapshot);
      throw new Error(
        gitFailureDetail(
          fastForwardResult,
          "Could not fast-forward to the published desktop tree.",
        ),
      );
    }
    landed = true;

    const reconciliation = await reconcileUpdaterOwnedPaths(
      stellaAppDir,
      changedFiles,
    );
    const dependencyInstallRan = await runDesktopUpdateDependencyInstall({
      stellaAppDir,
      changedFiles,
      runId,
      releaseTag: args.releaseTag,
    });

    let reloaded = true;
    if (runner && hmrRunStarted) {
      ({ reloaded } = await finishUpdateSelfModRun({
        runner,
        reacquireRunner: args.reacquireRunner,
        runId,
        paths: transitionPaths,
        logScope: "git",
        logFields: {
          runId,
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
        },
      }));
      hmrRunStarted = false;
    }
    await refreshNativeHelpers(
      stellaAppDir,
      args.releaseTag,
      args.artifactRefs,
      {
        transaction: args.transaction,
        mode: "git",
        changedFiles: transitionPaths,
      },
    );
    await reconcileUpdaterOwnedPaths(stellaAppDir, changedFiles);
    if (!reloaded) {
      return {
        status: "applied",
        manifest: null,
        headCommit: await readHeadCommit(stellaAppDir),
        changedFiles: transitionPaths,
        dependencyInstallRan,
        nativeHelpersRefreshed: true,
        reloaded: false,
      };
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "git",
      recoveryAction: "resume",
      changedFiles: transitionPaths,
    });
    const manifest = await writeAppliedCommit(
      stellaAppDir,
      args.targetCommit,
      args.releaseTag,
    );
    logDesktopUpdateProcess("desktop-update.git-fast-forward.done", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: changedFiles.length,
      changedFileScope: "release-update-files",
      browserBinaryActivated: reconciliation.browserBinaryActivated,
    });
    return {
      status: "applied",
      manifest,
      headCommit: await readHeadCommit(stellaAppDir),
      changedFiles: transitionPaths,
      dependencyInstallRan,
      nativeHelpersRefreshed: true,
      reloaded: true,
    };
  } catch (error) {
    if (!landed) {
      await discardStagedStellaBrowserUpdate(stellaAppDir, stagedBrowserPath);
    }
    if (hmrRunStarted && runner) {
      await runner
        .finishExternalSelfMod({ runId, succeeded: landed })
        .catch(() => undefined);
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
    artifactRefs?: StellaReleaseArtifactRef[];
    transaction?: DesktopUpdateTransaction;
    reacquireRunner?: ReacquireRunner;
  },
): Promise<DesktopUpdateFastApplyResult> => {
  logDesktopUpdateProcess("desktop-update.fast.start", {
    releaseTag: args.releaseTag,
    baseCommit: shortCommit(args.baseCommit),
    targetCommit: shortCommit(args.targetCommit),
  });

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
    "master",
  ]);
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      gitFailureDetail(fetchResult, "Failed to fetch the desktop update."),
    );
  }
  const remoteMasterResult = await runGit(stellaAppDir, [
    "rev-parse",
    "origin/master",
  ]);
  const remoteMaster = remoteMasterResult.stdout.trim().toLowerCase();
  if (
    remoteMasterResult.exitCode !== 0 ||
    remoteMaster !== args.targetCommit.toLowerCase()
  ) {
    throw new Error(
      `Published desktop commit ${args.targetCommit} did not match origin/master${remoteMaster ? ` ${remoteMaster}` : ""}.`,
    );
  }
  logDesktopUpdateProcess("desktop-update.git.fetch.done", {
    releaseTag: args.releaseTag,
    targetCommit: shortCommit(args.targetCommit),
  });

  const contentLanding = await tryFastForwardCleanPublishedTree(
    stellaAppDir,
    stellaDataDir,
    runner,
    args,
  );
  if (contentLanding) return contentLanding;

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
    const stagedBrowserPath = await stageStellaBrowserUpdate(
      stellaAppDir,
      args.artifactRefs,
    );
    const transitionPaths = stagedBrowserPath ? [stagedBrowserPath] : [];
    const alreadyLive =
      manifestBefore?.installState?.desktopReleaseCommit ===
        args.targetCommit && !stagedBrowserPath;
    logDesktopUpdateProcess("desktop-update.git.already-applied", {
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      alreadyLive,
      stagedBrowserPath,
    });
    let reloaded = alreadyLive;
    if (stagedBrowserPath) {
      if (!runner) {
        await discardStagedStellaBrowserUpdate(stellaAppDir, stagedBrowserPath);
        return {
          status: "needs-agent",
          reason:
            "Stella runtime is not available to activate the browser update.",
          headCommit: await readHeadCommit(stellaAppDir),
          changedFiles: transitionPaths,
        };
      }
      const runId = `desktop-update-git-browser-resume:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;
      await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
        phase: "dependency-install",
        mode: "git",
        recoveryAction: "resume",
        changedFiles: transitionPaths,
      });
      await withDesktopUpdateTimeout(
        "git-browser-resume.begin-external-self-mod",
        UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
        runner.beginExternalSelfMod({
          runId,
          paths: expandExternalSelfModPaths(transitionPaths),
        }),
        {
          runId,
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
          changedFileCount: transitionPaths.length,
        },
      );
      try {
        await reconcileUpdaterOwnedPaths(stellaAppDir, []);
        ({ reloaded } = await finishUpdateSelfModRun({
          runner,
          reacquireRunner: args.reacquireRunner,
          runId,
          paths: transitionPaths,
          logScope: "git",
          logFields: {
            runId,
            releaseTag: args.releaseTag,
            targetCommit: shortCommit(args.targetCommit),
          },
        }));
      } catch (error) {
        await runner
          .finishExternalSelfMod({ runId, succeeded: false })
          .catch(() => undefined);
        throw error;
      }
    }
    await refreshNativeHelpers(
      stellaAppDir,
      args.releaseTag,
      args.artifactRefs,
      {
        transaction: args.transaction,
        mode: "git",
        changedFiles: transitionPaths,
      },
    );
    await reconcileUpdaterOwnedPaths(stellaAppDir, []);
    if (!reloaded) {
      return {
        status: "applied",
        manifest: null,
        headCommit: await readHeadCommit(stellaAppDir),
        changedFiles: transitionPaths,
        dependencyInstallRan: false,
        nativeHelpersRefreshed: true,
        reloaded: false,
      };
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "git",
      recoveryAction: "resume",
      changedFiles: transitionPaths,
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
      changedFiles: transitionPaths,
      dependencyInstallRan: false,
      nativeHelpersRefreshed: true,
      reloaded: true,
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
      dirtyPaths: dirtyFiles,
      overlappingDirtyPaths: overlappingDirtyFiles,
      changedFileCount: changedFiles.length,
      changedFileScope: "release-update-files",
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
      dirtyPaths: dirtyFiles,
      changedFileCount: changedFiles.length,
      changedFileScope: "release-update-files",
    });
  }
  const stagedBrowserPath = await stageStellaBrowserUpdate(
    stellaAppDir,
    args.artifactRefs,
  );
  const transitionPaths = stagedBrowserPath
    ? [...new Set([...changedFiles, stagedBrowserPath])]
    : changedFiles;
  const runId = `desktop-update-fast:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  let hmrRunStarted = false;
  let mergeLanded = false;

  try {
    if (transitionPaths.length > 0) {
      if (!runner) {
        await discardStagedStellaBrowserUpdate(stellaAppDir, stagedBrowserPath);
        logDesktopUpdateWarn("desktop-update.fast.needs-agent", {
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
          reason: "runtime-unavailable-for-morph",
          changedFileCount: transitionPaths.length,
        });
        return {
          status: "needs-agent",
          reason: "Stella runtime is not available for the update morph.",
          headCommit: await readHeadCommit(stellaAppDir),
          changedFiles: transitionPaths,
        };
      }
      await withDesktopUpdateTimeout(
        "git.begin-external-self-mod",
        UPDATE_RUNTIME_HANDSHAKE_TIMEOUT_MS,
        runner.beginExternalSelfMod({
          runId,
          paths: expandExternalSelfModPaths(transitionPaths),
        }),
        {
          runId,
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
          changedFileCount: transitionPaths.length,
        },
      );
      hmrRunStarted = true;
    }

    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "git-merge",
      mode: "git",
      recoveryAction: "resume",
      changedFiles: transitionPaths,
    });
    logDesktopUpdateProcess("desktop-update.git.merge.start", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: transitionPaths.length,
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
      await discardStagedStellaBrowserUpdate(stellaAppDir, stagedBrowserPath);
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
        changedFileCount: transitionPaths.length,
      });
      return {
        status: "needs-agent",
        reason: gitFailureDetail(mergeResult, "Git could not merge cleanly."),
        changedFiles: transitionPaths,
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
    const browserReconciliation = await reconcileUpdaterOwnedPaths(
      stellaAppDir,
      [],
    );

    logDesktopUpdateProcess("desktop-update.fast.applied", {
      runId,
      releaseTag: args.releaseTag,
      targetCommit: shortCommit(args.targetCommit),
      changedFileCount: changedFiles.length,
      dependencyInstallRan,
      browserBinaryActivated: browserReconciliation.browserBinaryActivated,
    });
    // Drive the reload morph before helper refresh and completion recording.
    let reloaded = true;
    if (hmrRunStarted && runner) {
      ({ reloaded } = await finishUpdateSelfModRun({
        runner,
        reacquireRunner: args.reacquireRunner,
        runId,
        paths: transitionPaths,
        logScope: "git",
        logFields: {
          runId,
          releaseTag: args.releaseTag,
          targetCommit: shortCommit(args.targetCommit),
        },
      }));
      hmrRunStarted = false;
    }
    await refreshNativeHelpers(
      stellaAppDir,
      args.releaseTag,
      args.artifactRefs,
      {
        transaction: args.transaction,
        mode: "git",
        changedFiles: transitionPaths,
      },
    );
    await reconcileUpdaterOwnedPaths(stellaAppDir, []);
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
        changedFiles: transitionPaths,
        dependencyInstallRan,
        nativeHelpersRefreshed: true,
        reloaded: false,
      };
    }
    await writeDesktopUpdatePhase(stellaAppDir, args.transaction, {
      phase: "record-complete",
      mode: "git",
      recoveryAction: "resume",
      changedFiles: transitionPaths,
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
      changedFiles: transitionPaths,
      dependencyInstallRan,
      nativeHelpersRefreshed: true,
      reloaded: true,
    };
  } catch (error) {
    if (!mergeLanded) {
      await discardStagedStellaBrowserUpdate(stellaAppDir, stagedBrowserPath);
    }
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
        logDesktopUpdateWarn(
          "desktop-update.attempt-state.write-start-failed",
          {
            releaseTag,
            targetCommit: shortCommit(targetCommit),
            error,
          },
        );
      });
      logDesktopUpdateProcess("desktop-update.try-clean.start", {
        releaseTag,
        baseCommit: shortCommit(baseCommit),
        targetCommit: shortCommit(targetCommit),
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
        const manifest = await recordAppliedDesktopUpdate({
          stellaAppDir,
          runner: null,
          reacquireRunner: reacquireUpdateRunner,
          commit,
          tag,
          agentRunId,
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
