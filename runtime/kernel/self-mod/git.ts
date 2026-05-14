import { promises as fs } from "fs";
import { execFile } from "node:child_process";
import os from "os";
import path from "path";
import { promisify } from "node:util";
import { exec } from "dugite";

const LOG_ENTRY_SEPARATOR = "\x1e";
const LOG_FIELD_SEPARATOR = "\x1f";
const DEFAULT_RECENT_COMMIT_LIMIT = 8;
const execFileAsync = promisify(execFile);

type GitLogCommit = {
  hash: string;
  timestampMs: number;
  subject: string;
  body: string;
};

/**
 * Lightweight summary of one self-mod commit, surfaced to runtime
 * diagnostic UIs (Vite error overlay revert button, crash surface,
 * taint monitor toast). The legacy "feature" terminology is retained
 * in field names for renderer compatibility — `featureId` is just the
 * full commit hash since the per-feature index was removed.
 */
export type GitFeatureSummary = {
  featureId: string;
  name: string;
  description: string;
  latestCommit: string;
  latestTimestampMs: number;
  commitCount: number;
  tainted?: boolean;
  taintedFiles?: string[];
};

export type GitRevertResult = {
  featureId: string;
  revertedCommitHashes: string[];
  message: string;
  /**
   * Conversation id parsed from the reverted commit's
   * `Stella-Conversation` trailer. Used by the worker to insert a
   * `self_mod_reverts` row so the revert-notice hook can inform the
   * orchestrator on the next user turn. Null when the commit predates
   * the trailer or had no conversation attribution.
   */
  conversationId?: string | null;
  /**
   * Engine thread key of the agent that authored the reverted commit
   * (`Stella-Thread` trailer). Used by the revert-notice hook to also
   * inject the reminder if the orchestrator later resumes that same
   * thread via `send_input`. Null when the commit predates the trailer
   * — falls back to orchestrator-only routing in that case.
   *
   * Note: only the FIRST reverted commit's trailer is sampled when
   * `steps > 1`. The current renderer callsite always passes `steps: 1`,
   * so this is fine in practice; future multi-step callers would need
   * to union per-thread routing across the range.
   */
  originThreadKey?: string | null;
  /** Files touched by the reverted commit(s). Used for the hidden reminder text. */
  files?: string[];
};

export type SelfModAppliedPayload = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

export type GitCustomCommitArgs = {
  repoRoot: string;
  subject: string;
  bodyLines?: string[];
  /**
   * When provided, commits only these working-tree paths through an isolated
   * temporary index, ignoring whatever else may be staged. Use this for
   * self-mod commits to prevent pre-existing staged user changes from being
   * swept into an agent-authored commit while still including new files.
   */
  paths?: string[];
};

export type GitCommitReference = {
  commitHash: string;
  subject: string;
  body: string;
  files: string[];
  patch: string;
};

const normalizeGitPath = (value: string): string =>
  value.trim().replace(/\\/g, "/");

const runGit = async (
  repoRoot: string,
  args: string[],
  options?: {
    encoding?: "utf8" | "buffer";
    maxBuffer?: number;
  },
): Promise<string> => {
  const result = await exec(args, repoRoot, {
    encoding: options?.encoding === "buffer" ? "buffer" : "utf8",
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
  });
  if (result.exitCode === 0) {
    const stdout = result.stdout;
    return typeof stdout === "string"
      ? stdout.trim()
      : Buffer.from(stdout).toString("utf8").trim();
  }

  const stderr =
    typeof result.stderr === "string"
      ? result.stderr.trim()
      : Buffer.from(result.stderr).toString("utf8").trim();
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout.trim()
      : Buffer.from(result.stdout).toString("utf8").trim();
  const details = stderr || stdout || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
};

const runGitWithEnv = async (
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
    };
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const stdout = typeof err.stdout === "string" ? err.stdout.trim() : "";
    const details = stderr || stdout || `exit code ${String(err.code)}`;
    throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
  }
};

const runGitWithEnvStatus = async (
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: typeof err.stdout === "string" ? err.stdout.trim() : "",
      stderr: typeof err.stderr === "string" ? err.stderr.trim() : "",
    };
  }
};

const assertGitRepository = async (repoRoot: string): Promise<void> => {
  const output = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (output !== "true") {
    throw new Error("Not a git repository.");
  }
};

const parseGitLog = (raw: string): GitLogCommit[] => {
  if (!raw) return [];
  const records = raw
    .split(LOG_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const commits: GitLogCommit[] = [];
  for (const record of records) {
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 4) continue;
    const [hash, timestampSec, subject, body] = fields;
    const timestampMs = Number(timestampSec) * 1000;
    if (!hash || !Number.isFinite(timestampMs)) continue;
    commits.push({
      hash,
      timestampMs,
      subject: subject ?? "",
      body: body ?? "",
    });
  }
  return commits;
};

const parseStatusPath = (line: string): string | null => {
  if (!line || line.length < 4) return null;
  const rawPath = line.slice(3).trim();
  if (!rawPath) return null;
  const renameMarker = rawPath.lastIndexOf(" -> ");
  if (renameMarker >= 0) {
    return normalizeGitPath(rawPath.slice(renameMarker + 4));
  }
  return normalizeGitPath(rawPath);
};

const listDirtyFiles = async (repoRoot: string): Promise<string[]> => {
  const result = await exec([
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
  ], repoRoot, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Git command failed (status --porcelain): ${details}`);
  }
  const output = result.stdout.replace(/\r?\n$/, "");
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => parseStatusPath(line))
    .filter((line): line is string => Boolean(line));
};

/**
 * Dependency manifest/lock files that should follow the changes the
 * agent makes (e.g. `bun install` updating `bun.lock`). Returns only
 * the files that exist in the repo. Callers MUST further filter against
 * the run's baseline dirty set before staging — staging unconditionally
 * sweeps in unrelated user work.
 */
export const listDependencyFiles = async (repoRoot: string): Promise<string[]> => {
  const candidates = [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "npm-shrinkwrap.json",
  ];
  const existing: string[] = [];
  for (const relativePath of candidates) {
    try {
      await fs.access(path.join(repoRoot, relativePath));
      existing.push(relativePath);
    } catch {
      // Ignore missing dependency files.
    }
  }
  return existing;
};

const hasStagedChanges = async (repoRoot: string): Promise<boolean> => {
  const result = await exec(["diff", "--cached", "--quiet", "--exit-code"], repoRoot, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.exitCode === 0) {
    return false;
  }
  if (result.exitCode === 1) {
    return true;
  }
  const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (diff --cached --quiet --exit-code): ${details}`);
};

export const stageGitPathsForCommit = async (
  repoRoot: string,
  paths: string[],
): Promise<void> => {
  if (paths.length === 0) return;
  await runGit(repoRoot, ["add", "--", ...paths]);
};

const commitPathScopedChanges = async (
  repoRoot: string,
  paths: string[],
  commitArgs: string[],
): Promise<string | null> => {
  if (paths.length === 0) return null;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-git-index-"));
  const indexPath = path.join(tempDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await runGitWithEnv(repoRoot, ["read-tree", "HEAD"], env);
    await runGitWithEnv(repoRoot, ["add", "--", ...paths], env);
    const diff = await runGitWithEnvStatus(
      repoRoot,
      ["diff", "--cached", "--quiet", "--", ...paths],
      env,
    );
    if (diff.exitCode === 0) {
      return null;
    }
    if (diff.exitCode !== 1) {
      const details = diff.stderr || diff.stdout || `exit code ${diff.exitCode}`;
      throw new Error(
        `Git command failed (diff --cached --quiet -- <paths>): ${details}`,
      );
    }

    await runGitWithEnv(repoRoot, commitArgs, env);
    // The temporary index produced the commit; refresh only these paths in the
    // real index so unrelated staged user changes remain untouched.
    await runGit(repoRoot, ["reset", "-q", "--", ...paths]);
    return await getGitHead(repoRoot);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const getGitHead = async (repoRoot: string): Promise<string | null> => {
  await assertGitRepository(repoRoot);
  const output = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return output || null;
};

export const getGitHeadCommitSequence = async (
  repoRoot: string,
  count: number,
): Promise<string[]> => {
  await assertGitRepository(repoRoot);
  const safeCount = Math.max(1, Math.min(100, Math.floor(count)));
  const output = await runGit(repoRoot, [
    "rev-list",
    `--max-count=${safeCount}`,
    "HEAD",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const getChangedFilesForCommit = async (
  repoRoot: string,
  commitHash: string,
): Promise<string[]> => {
  const output = await runGit(repoRoot, [
    "show",
    "--name-only",
    "--pretty=format:",
    commitHash,
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/** Batch version: returns a map of commitHash → normalized file paths. */
export const getChangedFilesForCommits = async (
  repoRoot: string,
  commitHashes: string[],
): Promise<Map<string, string[]>> => {
  const result = new Map<string, string[]>();
  if (commitHashes.length === 0) return result;

  const separator = "---COMMIT_BOUNDARY---";
  const format = `${separator}%H`;
  const output = await runGit(repoRoot, [
    "show",
    "--name-only",
    `--pretty=format:${format}`,
    ...commitHashes,
  ]);

  const blocks = output.split(separator).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const hash = lines[0];
    const files = lines.slice(1).map(normalizeGitPath);
    result.set(hash, files);
  }

  return result;
};

const TRAILER_LINE_REGEX = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/;
const STELLA_INTERNAL_TRAILERS = new Set([
  "Stella-Conversation",
  "Stella-Thread",
  "Stella-Package-Id",
  "Stella-Release-Number",
  "Stella-Task",
  "Stella-Feature-Id",
  "Stella-Feature-Title",
  "Stella-Parent-Package-Id",
]);

export type StellaCommitTrailers = {
  conversationId?: string;
  /**
   * Engine thread key of the agent that authored this commit.
   * For orchestrator-authored commits this equals `conversationId`;
   * for subagent-authored commits this is the subagent's persisted
   * `agentId`/`threadId`. Used by the revert-notice hook to route
   * the "user undid your change" reminder back to the same thread
   * when the orchestrator later resumes it via `send_input`.
   * Optional — commits authored before this trailer existed have
   * no thread-level routing and fall back to conversation-only.
   */
  threadKey?: string;
  packageId?: string;
  featureId?: string;
  featureTitle?: string;
  /**
   * Multi-parent: a single feature group may legitimately extend more
   * than one installed add-on (e.g. a theme that touches two mods).
   * `Stella-Parent-Package-Id` is therefore allowed to repeat in a
   * single commit body. Order is preserved as written.
   */
  parentPackageIds: string[];
};

export const parseStellaCommitTrailers = (
  body: string,
): StellaCommitTrailers => {
  const trailers: StellaCommitTrailers = { parentPackageIds: [] };
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(TRAILER_LINE_REGEX);
    if (!match) continue;
    const [, key, value] = match;
    const trimmedValue = value?.trim();
    if (!trimmedValue) continue;
    if (key === "Stella-Conversation") {
      trailers.conversationId = trimmedValue;
    } else if (key === "Stella-Thread") {
      trailers.threadKey = trimmedValue;
    } else if (key === "Stella-Package-Id") {
      trailers.packageId = trimmedValue;
    } else if (key === "Stella-Feature-Id") {
      trailers.featureId = trimmedValue;
    } else if (key === "Stella-Feature-Title") {
      trailers.featureTitle = trimmedValue;
    } else if (key === "Stella-Parent-Package-Id") {
      trailers.parentPackageIds.push(trimmedValue);
    }
  }
  return trailers;
};


// Legacy commits from the pre-Phase-3 feature/batch scheme used a
// `[feature:<id>, +N]` subject prefix. We strip it so the normalized
// list shows clean human-readable subjects without rewriting history.
const LEGACY_FEATURE_TAG_REGEX = /\[feature:[a-zA-Z0-9_-]+(?:,\s*\+\d+)?\]/g;

const stripLegacyFeatureTagFromSubject = (subject: string): string => {
  LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;
  return subject.replace(LEGACY_FEATURE_TAG_REGEX, "").trim();
};

const stripStellaTrailerLinesFromBody = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const match = line.match(TRAILER_LINE_REGEX);
    if (!match) return true;
    return !STELLA_INTERNAL_TRAILERS.has(match[1] ?? "");
  });
  return filtered.join("\n").trim();
};

export type LocalGitCommitSummary = {
  commitHash: string;
  shortHash: string;
  subject: string;
  body: string;
  timestampMs: number;
  fileCount: number;
  files: string[];
  conversationId?: string;
  legacyFeatureTagged?: boolean;
  packageId?: string;
  /**
   * Stella self-mod grouping trailers, surfaced as first-class fields so
   * downstream consumers (the Store side panel's Publish flow) don't
   * have to re-parse `body` — which has all `Stella-*` trailers stripped
   * for human display before being returned.
   */
  featureId?: string;
  featureTitle?: string;
  parentPackageIds?: string[];
};

const FILE_PREVIEW_LIMIT = 12;

// Single ERE pattern used both server-side (`git log --grep`) and as an
// in-memory safety net. Matches any Stella-internal trailer key or the
// legacy `[feature:…]` tag, so non-Stella commits never reach the Store
// UI or publish path.
const STELLA_COMMIT_GREP_PATTERN =
  "Stella-(Conversation|Package-Id|Release-Number|Task|Feature-Id|Feature-Title|Parent-Package-Id)|\\[feature:";
const STELLA_COMMIT_VERIFY_REGEX = new RegExp(STELLA_COMMIT_GREP_PATTERN);
const STELLA_STORE_APPLY_TRAILER_REGEX =
  /^Stella-(Package-Id|Release-Number|Task):/m;

const isStellaSelfModCommitMessage = (rawMessage: string): boolean =>
  STELLA_COMMIT_VERIFY_REGEX.test(rawMessage);

const isPublishableStellaSelfModCommitMessage = (rawMessage: string): boolean =>
  isStellaSelfModCommitMessage(rawMessage)
  && !STELLA_STORE_APPLY_TRAILER_REGEX.test(rawMessage);

/**
 * Return recent local *Stella self-mod* commits as a flat list — that
 * is, agent-authored commits with `Stella-*` trailers (current scheme)
 * or legacy `[feature:…]`-tagged commits. Plain user/dev commits are
 * filtered out so the Store UI can't surface them as publishable
 * "creations" and the publish path can't ship non-Stella history.
 *
 * `body` and `subject` are sanitized for human display: legacy feature
 * tags are stripped from the subject, and Stella-internal trailers
 * (Conversation, Package-Id, etc.) are removed from the body.
 */
export const listRecentGitCommits = async (
  repoRoot: string,
  limit = 50,
): Promise<LocalGitCommitSummary[]> => {
  await assertGitRepository(repoRoot);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  // Install/update commits share Stella trailers but are not user-authored
  // creations. Overfetch before filtering so a run of store apply commits
  // does not make the Store UI look empty.
  const queryLimit = Math.min(2_000, Math.max(safeLimit, safeLimit * 4));
  const format = `%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${queryLimit}`,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${format}`,
  ]);

  const records = output
    .split(LOG_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const summaries: LocalGitCommitSummary[] = [];
  for (const record of records) {
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 5) continue;
    const [hash, shortHash, timestampSec, rawSubject, rawBody] = fields;
    const timestampMs = Number(timestampSec) * 1000;
    if (!hash || !Number.isFinite(timestampMs)) continue;

    const fullCombined = `${rawSubject ?? ""}\n${rawBody ?? ""}`;
    // Defense-in-depth: even with `--grep`, double-check the message
    // ourselves so a regex divergence between git and Node can't leak
    // non-Stella commits through.
    if (!isPublishableStellaSelfModCommitMessage(fullCombined)) continue;

    const trailers = parseStellaCommitTrailers(rawBody ?? "");
    const cleanSubject = stripLegacyFeatureTagFromSubject(rawSubject ?? "");
    const cleanBody = stripStellaTrailerLinesFromBody(rawBody ?? "");
    LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;
    const legacyFeatureTagged = LEGACY_FEATURE_TAG_REGEX.test(fullCombined);
    LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;

    let files: string[] = [];
    let fileCount = 0;
    try {
      files = await getChangedFilesForCommit(repoRoot, hash);
      fileCount = files.length;
      if (files.length > FILE_PREVIEW_LIMIT) {
        files = files.slice(0, FILE_PREVIEW_LIMIT);
      }
    } catch {
      // Best-effort; skip file enumeration on error.
    }

    summaries.push({
      commitHash: hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      subject: cleanSubject || "Self mod update",
      body: cleanBody,
      timestampMs,
      fileCount,
      files,
      ...(trailers.conversationId ? { conversationId: trailers.conversationId } : {}),
      ...(legacyFeatureTagged ? { legacyFeatureTagged: true } : {}),
      ...(trailers.packageId ? { packageId: trailers.packageId } : {}),
      ...(trailers.featureId ? { featureId: trailers.featureId } : {}),
      ...(trailers.featureTitle ? { featureTitle: trailers.featureTitle } : {}),
      ...(trailers.parentPackageIds.length > 0
        ? { parentPackageIds: trailers.parentPackageIds }
        : {}),
    });
    if (summaries.length >= safeLimit) {
      break;
    }
  }
  return summaries;
};

/**
 * Verify that every commit hash in `commitHashes` resolves to a
 * Stella self-mod commit (current `Stella-*` trailer scheme or the
 * legacy `[feature:…]` tag). Throws with a structured message listing
 * any unresolved or non-Stella hashes — used by the publish path so
 * the Store agent can't ship arbitrary commits from `git log`.
 */
export const assertStellaSelfModCommits = async (args: {
  repoRoot: string;
  commitHashes: string[];
}): Promise<void> => {
  await assertGitRepository(args.repoRoot);
  const dedup = Array.from(
    new Set(args.commitHashes.map((hash) => hash.trim()).filter(Boolean)),
  );
  if (dedup.length === 0) return;

  const unresolved: string[] = [];
  const nonStella: string[] = [];
  for (const hash of dedup) {
    let message: string;
    try {
      message = await runGit(args.repoRoot, [
        "show",
        "-s",
        "--format=%s%n%b",
        hash,
      ]);
    } catch {
      unresolved.push(hash);
      continue;
    }
    if (!isPublishableStellaSelfModCommitMessage(message)) {
      nonStella.push(hash);
    }
  }
  if (unresolved.length > 0 || nonStella.length > 0) {
    const parts: string[] = [];
    if (unresolved.length > 0) {
      parts.push(`unresolved: ${unresolved.join(", ")}`);
    }
    if (nonStella.length > 0) {
      parts.push(`not Stella self-mod commits: ${nonStella.join(", ")}`);
    }
    throw new Error(`Refusing to publish ${parts.join("; ")}`);
  }
};

/**
 * Return recent local self-mod commits as `GitFeatureSummary`-shaped
 * entries. Each commit becomes one summary with `featureId === commitHash`,
 * preserving the existing `SelfModFeatureSummary` contract used by the
 * runtime diagnostic UIs (revert button, crash surface, taint monitor).
 */
export const listRecentGitFeatures = async (
  repoRoot: string,
  limit = DEFAULT_RECENT_COMMIT_LIMIT,
): Promise<GitFeatureSummary[]> => {
  await assertGitRepository(repoRoot);
  const safeLimit = Math.max(1, Math.floor(limit));
  const commitFormat = `%H${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${safeLimit}`,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${commitFormat}`,
  ]);
  const commits = parseGitLog(output).filter((commit) =>
    isStellaSelfModCommitMessage(`${commit.subject}\n${commit.body}`));
  if (commits.length === 0) {
    return [];
  }

  const summaries: GitFeatureSummary[] = commits.map((commit) => {
    const cleanedSubject =
      stripLegacyFeatureTagFromSubject(commit.subject) || "Self mod update";
    const cleanedBody = stripStellaTrailerLinesFromBody(commit.body);
    return {
      featureId: commit.hash,
      name: cleanedSubject,
      description: cleanedBody,
      latestCommit: commit.hash,
      latestTimestampMs: commit.timestampMs,
      commitCount: 1,
    };
  });

  const dirtyFiles = await listDirtyFiles(repoRoot);
  if (dirtyFiles.length === 0) {
    return summaries;
  }

  const filesByCommit = await getChangedFilesForCommits(
    repoRoot,
    summaries.map((entry) => entry.latestCommit),
  );
  const dirtySet = new Set(dirtyFiles);
  for (const summary of summaries) {
    const touched = filesByCommit.get(summary.latestCommit) ?? [];
    const taintedFiles = touched.filter((file) => dirtySet.has(file));
    if (taintedFiles.length > 0) {
      summary.tainted = true;
      summary.taintedFiles = taintedFiles;
    }
  }

  return summaries;
};

/**
 * Raw, parsed commit feed used by `feature-roster.ts` (and any other
 * caller that wants to walk Stella self-mod history). Returns one entry
 * per commit with subject + body (untouched - parsing of trailers is
 * the caller's job, since different consumers want different fields).
 *
 * Cap defaults to 4_000 commits; even active users won't usually exceed
 * that, and Stella can grow the cap if needed since this is a
 * read-only walk that doesn't hit the working tree.
 */
export const listStellaFeatureCommitsRaw = async (
  repoRoot: string,
  limit = 4_000,
): Promise<Array<{
  hash: string;
  timestampMs: number;
  subject: string;
  body: string;
}>> => {
  await assertGitRepository(repoRoot);
  const safeLimit = Math.max(1, Math.min(20_000, Math.floor(limit)));
  const format = `%H${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${safeLimit}`,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${format}`,
  ]);
  const commits: Array<{
    hash: string;
    timestampMs: number;
    subject: string;
    body: string;
  }> = [];
  for (const record of output
    .split(LOG_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 4) continue;
    const [hash, timestampSec, subject, body] = fields;
    const timestampMs = Number(timestampSec) * 1000;
    if (!hash || !Number.isFinite(timestampMs)) continue;
    commits.push({
      hash,
      timestampMs,
      subject: subject ?? "",
      body: body ?? "",
    });
  }
  return commits;
};

/**
 * Build the same `LocalGitCommitSummary` shape `listRecentGitCommits`
 * returns, but for a *targeted* commit selector — either a set of
 * `Stella-Feature-Id` trailers or an explicit list of commit hashes.
 *
 * This sidesteps the recent-commit window mismatch (the side-panel
 * roster keeps 90-day-old features, but the publish path used to slice
 * only the latest 120 commits). We walk up to `scanLimit` Stella
 * self-mod commits — the same window the roster scans — and only do
 * file enumeration for matched commits, so this is cheap even at the
 * 4_000 cap.
 */
export const listGitCommitsBySelector = async (
  repoRoot: string,
  selector: { featureIds?: string[]; commitHashes?: string[] },
  scanLimit = 4_000,
): Promise<LocalGitCommitSummary[]> => {
  const featureIdSet = new Set(
    (selector.featureIds ?? [])
      .map((id) => id?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  const hashSet = new Set(
    (selector.commitHashes ?? [])
      .map((hash) => hash?.trim())
      .filter((hash): hash is string => Boolean(hash)),
  );
  if (featureIdSet.size === 0 && hashSet.size === 0) return [];

  await assertGitRepository(repoRoot);
  const safeScanLimit = Math.max(1, Math.min(20_000, Math.floor(scanLimit)));
  const format = `%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${safeScanLimit}`,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${format}`,
  ]);

  const records = output
    .split(LOG_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const summaries: LocalGitCommitSummary[] = [];
  for (const record of records) {
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 5) continue;
    const [hash, shortHash, timestampSec, rawSubject, rawBody] = fields;
    const timestampMs = Number(timestampSec) * 1000;
    if (!hash || !Number.isFinite(timestampMs)) continue;

    const fullCombined = `${rawSubject ?? ""}\n${rawBody ?? ""}`;
    if (!isPublishableStellaSelfModCommitMessage(fullCombined)) continue;

    const trailers = parseStellaCommitTrailers(rawBody ?? "");

    const matchesHash = hashSet.has(hash);
    const matchesFeature = trailers.featureId
      ? featureIdSet.has(trailers.featureId)
      : false;
    if (!matchesHash && !matchesFeature) continue;

    const cleanSubject = stripLegacyFeatureTagFromSubject(rawSubject ?? "");
    const cleanBody = stripStellaTrailerLinesFromBody(rawBody ?? "");
    LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;
    const legacyFeatureTagged = LEGACY_FEATURE_TAG_REGEX.test(fullCombined);
    LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;

    let files: string[] = [];
    let fileCount = 0;
    try {
      files = await getChangedFilesForCommit(repoRoot, hash);
      fileCount = files.length;
      if (files.length > FILE_PREVIEW_LIMIT) {
        files = files.slice(0, FILE_PREVIEW_LIMIT);
      }
    } catch {
      // best-effort
    }

    summaries.push({
      commitHash: hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      subject: cleanSubject || "Self mod update",
      body: cleanBody,
      timestampMs,
      fileCount,
      files,
      ...(trailers.conversationId ? { conversationId: trailers.conversationId } : {}),
      ...(legacyFeatureTagged ? { legacyFeatureTagged: true } : {}),
      ...(trailers.packageId ? { packageId: trailers.packageId } : {}),
      ...(trailers.featureId ? { featureId: trailers.featureId } : {}),
      ...(trailers.featureTitle ? { featureTitle: trailers.featureTitle } : {}),
      ...(trailers.parentPackageIds.length > 0
        ? { parentPackageIds: trailers.parentPackageIds }
        : {}),
    });
  }
  return summaries;
};

/**
 * Hash of the most recent self-mod commit (i.e. HEAD), or null when the
 * repo has no commits. Renamed from the legacy "last feature id" but
 * kept under the same export so the worker doesn't need to fork.
 */
export const getLastGitFeatureId = async (
  repoRoot: string,
): Promise<string | null> => {
  await assertGitRepository(repoRoot);
  const output = await runGit(repoRoot, [
    "log",
    "--max-count=1",
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    "--pretty=format:%H",
  ]);
  return output || null;
};

/**
 * Revert one or more self-mod commits. The legacy API took a
 * `featureId` and reverted every commit tagged with it; with the
 * feature-tag scheme gone, `featureId` is now interpreted as a single
 * commit hash and `steps` controls how far back from there to revert
 * (defaults to 1). Passing no `featureId` reverts from HEAD.
 *
 * NOTE: `steps > 1` currently throws — the returned
 * `originThreadKey`/`conversationId` are sampled from the first
 * reverted commit only and would mis-route the revert-notice hook
 * across thread boundaries. Lift this guard once a caller wires
 * per-thread fan-out across the reverted range.
 */
export const revertGitFeature = async (args: {
  repoRoot: string;
  featureId?: string | null;
  steps?: number;
}): Promise<GitRevertResult> => {
  const { repoRoot } = args;
  await assertGitRepository(repoRoot);

  const startCommit =
    args.featureId?.trim() || (await getLastGitFeatureId(repoRoot)) || "";
  if (!startCommit) {
    throw new Error("No commit found to revert.");
  }

  if (args.featureId?.trim()) {
    const message = await runGit(repoRoot, [
      "show",
      "-s",
      "--format=%s%n%b",
      startCommit,
    ]);
    if (!isStellaSelfModCommitMessage(message)) {
      throw new Error(`Refusing to revert non-Stella self-mod commit "${startCommit}".`);
    }
  }

  const steps = Math.max(1, Math.floor(args.steps ?? 1));
  // Multi-step reverts collapse cross-thread attribution: the
  // `originThreadKey`/`conversationId` returned below are sampled from
  // the FIRST reverted commit only, so the revert-notice hook would
  // mis-route the hidden reminder when reverted commits span multiple
  // agent threads. The only live caller (the inline "Undo changes"
  // affordance) always passes `steps: 1`, so explicitly refuse anything
  // larger until a multi-step caller lands with its own per-thread
  // routing strategy. Safer than relying on prose.
  if (steps > 1) {
    throw new Error(
      `revertGitFeature called with steps=${steps}; multi-step reverts collapse Stella-Thread / Stella-Conversation trailer attribution to the first commit and would mis-route the revert-notice reminder. Reduce to steps=1 or extend the caller to fan attribution across the range.`,
    );
  }
  let commitHashes: string[] = [];
  try {
    const output = await runGit(repoRoot, [
      "log",
      `--max-count=${steps}`,
      "--extended-regexp",
      `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
      "--pretty=format:%H",
      startCommit,
    ]);
    commitHashes = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Could not resolve commit "${startCommit}" for revert: ${(error as Error).message}`,
    );
  }
  if (commitHashes.length === 0) {
    throw new Error(`No commits found for "${startCommit}".`);
  }

  // Read trailer + touched files BEFORE the revert so we still have a
  // clean handle on the original commit's metadata. After `git revert`,
  // a fresh "Revert ..." commit lands at HEAD with its own trailers,
  // so post-revert lookups would attribute the change to the wrong
  // conversation.
  const sourceCommit = commitHashes[0] ?? startCommit;
  let conversationId: string | null = null;
  let originThreadKey: string | null = null;
  let files: string[] = [];
  try {
    const body = await runGit(repoRoot, [
      "show",
      "-s",
      "--format=%B",
      sourceCommit,
    ]);
    const parsed = parseStellaCommitTrailers(body);
    conversationId = parsed.conversationId ?? null;
    originThreadKey = parsed.threadKey ?? null;
  } catch {
    // Trailer parsing must not block the revert itself.
  }
  try {
    const nameOnly = await runGit(repoRoot, [
      "show",
      "--name-only",
      "--no-renames",
      "--pretty=format:",
      sourceCommit,
    ]);
    files = nameOnly
      .split("\n")
      .map((line) => normalizeGitPath(line.trim()))
      .filter(Boolean);
  } catch {
    // File enumeration is best-effort; reminder text just omits the list.
  }

  const reverted = await revertGitCommits({
    repoRoot,
    commitHashes,
  });

  return {
    featureId: startCommit,
    revertedCommitHashes: reverted,
    message:
      reverted.length === 1
        ? `Reverted 1 commit (${reverted[0]?.slice(0, 7)}).`
        : `Reverted ${reverted.length} commits.`,
    conversationId,
    originThreadKey,
    files,
  };
};

/**
 * Repo-relative file paths touched by a specific commit (defaults to
 * the latest Stella self-mod commit when no hash is given). Used by
 * the revert handler to snapshot pre-revert disk content into the
 * self-mod HMR controller so the renderer cross-fades cleanly rather
 * than reacting to a naked file change.
 */
export const listFilesForCommit = async (
  repoRoot: string,
  commitHash: string | null,
): Promise<string[]> => {
  await assertGitRepository(repoRoot);
  const target =
    commitHash?.trim() || (await getLastGitFeatureId(repoRoot)) || "";
  if (!target) {
    return [];
  }
  const output = await runGit(repoRoot, [
    "show",
    "--name-only",
    "--no-renames",
    "--pretty=format:",
    target,
  ]);
  return output
    .split("\n")
    .map((line) => normalizeGitPath(line.trim()))
    .filter(Boolean);
};

export const listGitDirtyFiles = async (repoRoot: string): Promise<string[]> => {
  await assertGitRepository(repoRoot);
  return await listDirtyFiles(repoRoot);
};

export const discardGitDirtyFiles = async (
  repoRoot: string,
): Promise<{ discardedFileCount: number }> => {
  await assertGitRepository(repoRoot);
  const dirtyFiles = await listDirtyFiles(repoRoot);
  if (dirtyFiles.length === 0) {
    return { discardedFileCount: 0 };
  }

  await runGit(repoRoot, ["reset", "--hard", "HEAD"]);
  await runGit(repoRoot, ["clean", "-fd"]);

  return { discardedFileCount: dirtyFiles.length };
};

/**
 * Return a truncated unified diff for the changes about to be committed.
 *
 * Used to prompt the modifying agent for a commit message without sending
 * unbounded patch bytes through the LLM. We cap line count rather than byte
 * count because the model only needs an overview of edits.
 *
 * When `paths` is provided (the self-mod path), we diff the working tree
 * against `HEAD` scoped to those paths — this matches what
 * `git commit --only -- <paths>` will end up committing. Otherwise we
 * fall back to the staged diff.
 */
export const getStagedDiffPreview = async (
  repoRoot: string,
  options?: { maxLines?: number; paths?: string[] },
): Promise<string> => {
  const maxLines = Math.max(20, options?.maxLines ?? 400);
  const paths = normalizePathspecs(options?.paths);
  const diffArgs: string[] =
    paths.length > 0
      ? ["diff", "HEAD", "--unified=2", "--no-color", "--stat-width=120", "--", ...paths]
      : ["diff", "--cached", "--unified=2", "--no-color", "--stat-width=120"];
  const raw = await runGit(repoRoot, diffArgs);
  if (!raw) return "";
  const lines = raw.split("\n");
  if (lines.length <= maxLines) {
    return raw;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n... [diff truncated, ${lines.length - maxLines} more lines]`;
};

export const commitGitOperation = async (
  args: GitCustomCommitArgs,
): Promise<string | null> => {
  await assertGitRepository(args.repoRoot);
  const paths = normalizePathspecs(args.paths);
  if (paths.length === 0 && !(await hasStagedChanges(args.repoRoot))) {
    return null;
  }

  const commitArgs: string[] = [
    "commit",
    "-m",
    args.subject,
    "-m",
    (args.bodyLines ?? []).join("\n"),
  ];
  if (paths.length > 0) {
    return await commitPathScopedChanges(args.repoRoot, paths, commitArgs);
  }
  await runGit(args.repoRoot, commitArgs);
  return await getGitHead(args.repoRoot);
};

export type GitMessageCommitArgs = {
  repoRoot: string;
  /** Single-line subject, free-form. Will be sanitized to a single line. */
  subject: string;
  /** Optional body paragraphs (free-form). */
  body?: string;
  /**
   * RFC 822-style commit trailers like { "Stella-Conversation": "<id>" }.
   * Pass an array as the value to emit the trailer multiple times
   * (used for `Stella-Parent-Package-Id` when a feature extends
   * more than one installed add-on).
   */
  trailers?: Record<string, string | string[]>;
  /**
   * When provided, commits only these working-tree paths through an isolated
   * temporary index, ignoring whatever else may be staged. Use this for
   * self-mod commits to prevent pre-existing staged user changes from being
   * swept into an agent-authored commit while still including new files.
   */
  paths?: string[];
};

const normalizePathspecs = (paths: string[] | undefined): string[] => {
  if (!paths || paths.length === 0) return [];
  return Array.from(
    new Set(paths.map((entry) => normalizeGitPath(entry)).filter(Boolean)),
  );
};

const SUBJECT_MAX_LENGTH = 72;

const sanitizeCommitSubject = (raw: string): string => {
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .split("\n")[0]
    ?.trim()
    ?? "";
  if (cleaned.length <= SUBJECT_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, SUBJECT_MAX_LENGTH - 1).trim()}…`;
};

const formatTrailer = (key: string, value: string): string => {
  const safeKey = key.replace(/[\s:]+/g, "-");
  const safeValue = value.replace(/\r?\n/g, " ").trim();
  return `${safeKey}: ${safeValue}`;
};

/**
 * Commit currently-staged changes with a free-form, agent-authored message.
 *
 * Use this for the self-mod tracking flow where the modifying agent
 * produces a human-readable commit message and the runtime appends machine
 * trailers (e.g. `Stella-Conversation: <id>`) for later context lookup.
 */
export const commitGitMessage = async (
  args: GitMessageCommitArgs,
): Promise<string | null> => {
  await assertGitRepository(args.repoRoot);
  const paths = normalizePathspecs(args.paths);
  if (paths.length === 0 && !(await hasStagedChanges(args.repoRoot))) {
    return null;
  }

  const subject = sanitizeCommitSubject(args.subject);
  if (!subject) {
    throw new Error("commitGitMessage requires a non-empty subject.");
  }

  const trailerLines: string[] = [];
  for (const [key, value] of Object.entries(args.trailers ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      const trimmed = entry?.trim();
      if (trimmed) trailerLines.push(formatTrailer(key, trimmed));
    }
  }

  const body = (args.body ?? "").replace(/\r\n/g, "\n").trim();

  const commitArgs: string[] = ["commit", "-m", subject];
  if (body) {
    commitArgs.push("-m", body);
  }
  if (trailerLines.length > 0) {
    commitArgs.push("-m", trailerLines.join("\n"));
  }
  if (paths.length > 0) {
    return await commitPathScopedChanges(args.repoRoot, paths, commitArgs);
  }

  await runGit(args.repoRoot, commitArgs);
  return await getGitHead(args.repoRoot);
};

export const getCommitFileSnapshot = async (args: {
  repoRoot: string;
  commitHash: string;
  filePath: string;
}): Promise<{ path: string; deleted: boolean; contentBase64?: string }> => {
  await assertGitRepository(args.repoRoot);
  const gitPath = normalizeGitPath(args.filePath);
  const result = await exec(
    ["show", `${args.commitHash}:${gitPath}`],
    args.repoRoot,
    {
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024,
    },
  );
  if (result.exitCode === 0) {
    const buffer = Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout);
    return {
      path: gitPath,
      deleted: false,
      contentBase64: buffer.toString("base64"),
    };
  }
  if (result.exitCode === 128) {
    return {
      path: gitPath,
      deleted: true,
    };
  }
  const details =
    (Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr).trim()
    || (Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout).trim()
    || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (show ${args.commitHash}:${gitPath}): ${details}`);
};

/**
 * Order an arbitrary set of commit hashes by their git timestamp (oldest
 * first). Useful when an external caller (e.g. the Store agent) hands us a
 * picked-list of commits without preserving chronological order.
 *
 * Throws with a structured message listing any unresolved hashes so a
 * typo or stale selection can never silently produce a partial release.
 * Duplicate hashes are deduplicated up front and do NOT count as missing.
 */
export const orderCommitHashesChronologically = async (args: {
  repoRoot: string;
  commitHashes: string[];
}): Promise<string[]> => {
  await assertGitRepository(args.repoRoot);
  const dedup = Array.from(
    new Set(args.commitHashes.map((hash) => hash.trim()).filter(Boolean)),
  );
  if (dedup.length === 0) {
    return [];
  }
  const entries: Array<{ hash: string; timestampMs: number }> = [];
  const missing: string[] = [];
  for (const hash of dedup) {
    try {
      const output = await runGit(args.repoRoot, [
        "show",
        "-s",
        "--format=%H%x1f%ct",
        hash,
      ]);
      const [resolvedHash, timestampSec] = output.split("\x1f");
      if (!resolvedHash) {
        missing.push(hash);
        continue;
      }
      const timestampMs = Number(timestampSec) * 1000;
      if (!Number.isFinite(timestampMs)) {
        missing.push(hash);
        continue;
      }
      entries.push({ hash: resolvedHash.trim(), timestampMs });
    } catch {
      missing.push(hash);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Could not resolve ${missing.length} commit hash(es): ${missing.join(", ")}`,
    );
  }
  entries.sort((left, right) => left.timestampMs - right.timestampMs);
  return entries.map((entry) => entry.hash);
};

export const getCommitReference = async (args: {
  repoRoot: string;
  commitHash: string;
}): Promise<GitCommitReference> => {
  await assertGitRepository(args.repoRoot);
  const format = `%s${LOG_FIELD_SEPARATOR}%b`;
  const output = await runGit(args.repoRoot, [
    "show",
    "--stat=0",
    `--format=${format}`,
    args.commitHash,
  ]);
  const [subject = "", body = ""] = output.split(LOG_FIELD_SEPARATOR);
  const files = await getChangedFilesForCommit(args.repoRoot, args.commitHash);
  const patch = await runGit(args.repoRoot, [
    "show",
    "--format=",
    "--unified=3",
    args.commitHash,
  ]);
  return {
    commitHash: args.commitHash,
    subject,
    body,
    files,
    patch,
  };
};

export const getCommitSelectionSnapshots = async (args: {
  repoRoot: string;
  commitHashes: string[];
  files: string[];
}): Promise<Array<{ path: string; deleted: boolean; contentBase64?: string }>> => {
  await assertGitRepository(args.repoRoot);
  const commitHashes = Array.from(new Set(args.commitHashes.map((hash) => hash.trim()).filter(Boolean)));
  const files = Array.from(new Set(args.files.map(normalizeGitPath).filter(Boolean)));
  if (commitHashes.length === 0 || files.length === 0) {
    return [];
  }

  const firstCommitHash = commitHashes[0];
  let baseCommitHash: string;
  try {
    baseCommitHash = await runGit(args.repoRoot, ["rev-parse", `${firstCommitHash}^`]);
  } catch {
    throw new Error("Selected commits could not be reconstructed from git history.");
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stella-store-release-"));
  const worktreePath = path.join(tempRoot, "worktree");

  try {
    await runGit(args.repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommitHash]);
    try {
      for (const commitHash of commitHashes) {
        try {
          await runGit(worktreePath, ["cherry-pick", "--allow-empty", commitHash]);
        } catch (error) {
          try {
            await runGit(worktreePath, ["cherry-pick", "--abort"]);
          } catch {
            // Best effort only.
          }
          throw new Error(
            `Selected commits could not be reconstructed: ${(error as Error).message}`,
          );
        }
      }

      const snapshots: Array<{ path: string; deleted: boolean; contentBase64?: string }> = [];
      for (const filePath of files) {
        const absolutePath = path.join(worktreePath, filePath);
        try {
          const buffer = await fs.readFile(absolutePath);
          snapshots.push({
            path: filePath,
            deleted: false,
            contentBase64: buffer.toString("base64"),
          });
        } catch {
          snapshots.push({
            path: filePath,
            deleted: true,
          });
        }
      }
      return snapshots;
    } finally {
      await runGit(args.repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const listCommitFiles = async (
  repoRoot: string,
  commitHash: string,
): Promise<string[]> => {
  await assertGitRepository(repoRoot);
  return await getChangedFilesForCommit(repoRoot, commitHash);
};

export const revertGitCommits = async (args: {
  repoRoot: string;
  commitHashes: string[];
}): Promise<string[]> => {
  await assertGitRepository(args.repoRoot);
  const reverted: string[] = [];
  for (const hash of args.commitHashes) {
    try {
      await runGit(args.repoRoot, ["revert", "--no-edit", hash]);
      reverted.push(hash);
    } catch (error) {
      try {
        await runGit(args.repoRoot, ["revert", "--abort"]);
      } catch {
        // Best effort only.
      }
      throw error;
    }
  }
  return reverted;
};

/**
 * Detect whether new self-mod commits landed on `repoRoot` since
 * `sinceHead`. Returns a `SelfModAppliedPayload` describing the most
 * recent commit (its hash becomes the synthetic `featureId`) so the
 * runtime can surface an undo affordance against it. Returns null
 * when no new commits exist.
 */
export const detectSelfModAppliedSince = async (args: {
  repoRoot: string;
  sinceHead: string | null;
}): Promise<SelfModAppliedPayload | null> => {
  const { repoRoot, sinceHead } = args;
  await assertGitRepository(repoRoot);

  const range = sinceHead ? `${sinceHead}..HEAD` : "HEAD";
  const format = `%H${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;
  const output = await runGit(repoRoot, [
    "log",
    range,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${format}`,
    `--max-count=1`,
  ]);
  const commits = parseGitLog(output).filter((commit) =>
    isStellaSelfModCommitMessage(`${commit.subject}\n${commit.body}`));
  const latest = commits[0];
  if (!latest) {
    return null;
  }

  const files = await getChangedFilesForCommit(repoRoot, latest.hash);
  return {
    featureId: latest.hash,
    files,
    batchIndex: 0,
  };
};
