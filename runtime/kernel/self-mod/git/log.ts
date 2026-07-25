import type { SelfModCommitSummary } from "../../../contracts/index.js";
import type { SelfModCommitAppliedPayload } from "../../../contracts/local-chat.js";
import {
  assertGitRepository,
  normalizeGitPath,
  runGit,
  runGitStatus,
  toTrimmedString,
} from "./exec.js";
import {
  STELLA_COMMIT_GREP_PATTERN,
  hasLegacyFeatureTag,
  isPublishableStellaSelfModCommitMessage,
  isStellaSelfModCommitMessage,
  parseStellaCommitTrailers,
  stripLegacyFeatureTagFromSubject,
  stripStellaTrailerLinesFromBody,
} from "./trailers.js";

export const LOG_ENTRY_SEPARATOR = "\x1e";
export const LOG_FIELD_SEPARATOR = "\x1f";
const DEFAULT_RECENT_COMMIT_LIMIT = 8;
const FILE_PREVIEW_LIMIT = 12;

type GitLogCommit = {
  hash: string;
  timestampMs: number;
  subject: string;
  body: string;
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
  const result = await runGitStatus(repoRoot, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
  ]);
  if (result.exitCode !== 0) {
    const details =
      toTrimmedString(result.stderr) ||
      toTrimmedString(result.stdout) ||
      `exit code ${result.exitCode}`;
    throw new Error(`Git command failed (status --porcelain): ${details}`);
  }
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString("utf8")
    : result.stdout;
  const output = stdout.replace(/\r?\n$/, "");
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => parseStatusPath(line))
    .filter((line): line is string => Boolean(line));
};

export const listGitDirtyFiles = async (
  repoRoot: string,
): Promise<string[]> => {
  await assertGitRepository(repoRoot);
  return await listDirtyFiles(repoRoot);
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

export const getGitCommitParent = async (
  repoRoot: string,
  commitHash: string,
): Promise<string | null> => {
  await assertGitRepository(repoRoot);
  const result = await runGitStatus(repoRoot, [
    "rev-parse",
    `${commitHash.trim()}^`,
  ]);
  if (result.exitCode === 0) {
    return toTrimmedString(result.stdout) || null;
  }
  return null;
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
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const hash = lines[0];
    const files = lines.slice(1).map(normalizeGitPath);
    result.set(hash, files);
  }

  return result;
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
    commitHash?.trim() || (await getLastSelfModCommitHash(repoRoot)) || "";
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

type ParsedSelfModLogRecord = {
  hash: string;
  shortHash: string;
  timestampMs: number;
  rawSubject: string;
  rawBody: string;
};

const SELF_MOD_LOG_FORMAT = `%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;

const parseSelfModLogRecords = (output: string): ParsedSelfModLogRecord[] => {
  const records: ParsedSelfModLogRecord[] = [];
  for (const record of output
    .split(LOG_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 5) continue;
    const [hash, shortHash, timestampSec, rawSubject, rawBody] = fields;
    const timestampMs = Number(timestampSec) * 1000;
    if (!hash || !Number.isFinite(timestampMs)) continue;
    records.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      timestampMs,
      rawSubject: rawSubject ?? "",
      rawBody: rawBody ?? "",
    });
  }
  return records;
};

const buildLocalGitCommitSummary = (
  record: ParsedSelfModLogRecord,
  files: string[],
): LocalGitCommitSummary => {
  const fullCombined = `${record.rawSubject}\n${record.rawBody}`;
  const trailers = parseStellaCommitTrailers(record.rawBody);
  const cleanSubject = stripLegacyFeatureTagFromSubject(record.rawSubject);
  const cleanBody = stripStellaTrailerLinesFromBody(record.rawBody);
  const legacyFeatureTagged = hasLegacyFeatureTag(fullCombined);
  const fileCount = files.length;
  const previewFiles =
    files.length > FILE_PREVIEW_LIMIT
      ? files.slice(0, FILE_PREVIEW_LIMIT)
      : files;

  return {
    commitHash: record.hash,
    shortHash: record.shortHash,
    subject: cleanSubject || "Self mod update",
    body: cleanBody,
    timestampMs: record.timestampMs,
    fileCount,
    files: previewFiles,
    ...(trailers.conversationId
      ? { conversationId: trailers.conversationId }
      : {}),
    ...(legacyFeatureTagged ? { legacyFeatureTagged: true } : {}),
    ...(trailers.packageId ? { packageId: trailers.packageId } : {}),
    ...(trailers.featureId ? { featureId: trailers.featureId } : {}),
    ...(trailers.featureTitle ? { featureTitle: trailers.featureTitle } : {}),
    ...(trailers.parentPackageIds.length > 0
      ? { parentPackageIds: trailers.parentPackageIds }
      : {}),
  };
};

const toSummariesWithBatchedFiles = async (
  repoRoot: string,
  records: ParsedSelfModLogRecord[],
): Promise<LocalGitCommitSummary[]> => {
  let filesByCommit = new Map<string, string[]>();
  try {
    filesByCommit = await getChangedFilesForCommits(
      repoRoot,
      records.map((record) => record.hash),
    );
  } catch {
    // Best-effort; summaries fall back to empty file lists.
  }
  return records.map((record) =>
    buildLocalGitCommitSummary(record, filesByCommit.get(record.hash) ?? []),
  );
};

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
 *
 * File enumeration runs as ONE batched `git show` over the matched
 * commits rather than one subprocess per commit.
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
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${queryLimit}`,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${SELF_MOD_LOG_FORMAT}`,
  ]);

  // Defense-in-depth: even with `--grep`, double-check the message
  // ourselves so a regex divergence between git and Node can't leak
  // non-Stella commits through.
  const records = parseSelfModLogRecords(output)
    .filter((record) =>
      isPublishableStellaSelfModCommitMessage(
        `${record.rawSubject}\n${record.rawBody}`,
      ),
    )
    .slice(0, safeLimit);
  return await toSummariesWithBatchedFiles(repoRoot, records);
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
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${safeScanLimit}`,
    "--extended-regexp",
    `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
    `--pretty=format:${SELF_MOD_LOG_FORMAT}`,
  ]);

  const records = parseSelfModLogRecords(output).filter((record) => {
    if (
      !isPublishableStellaSelfModCommitMessage(
        `${record.rawSubject}\n${record.rawBody}`,
      )
    ) {
      return false;
    }
    if (hashSet.has(record.hash)) return true;
    const trailers = parseStellaCommitTrailers(record.rawBody);
    return trailers.featureId ? featureIdSet.has(trailers.featureId) : false;
  });
  return await toSummariesWithBatchedFiles(repoRoot, records);
};

/**
 * Return recent self-mod commits as `SelfModCommitSummary` entries
 * (one per commit) for the runtime diagnostic UIs (revert button,
 * crash surface, taint monitor).
 */
export const listRecentSelfModCommits = async (
  repoRoot: string,
  limit = DEFAULT_RECENT_COMMIT_LIMIT,
): Promise<SelfModCommitSummary[]> => {
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
    isStellaSelfModCommitMessage(`${commit.subject}\n${commit.body}`),
  );
  if (commits.length === 0) {
    return [];
  }

  const summaries: SelfModCommitSummary[] = commits.map((commit) => ({
    commitHash: commit.hash,
    name: stripLegacyFeatureTagFromSubject(commit.subject) || "Self mod update",
    description: stripStellaTrailerLinesFromBody(commit.body),
    timestampMs: commit.timestampMs,
  }));

  const dirtyFiles = await listDirtyFiles(repoRoot);
  if (dirtyFiles.length === 0) {
    return summaries;
  }

  const filesByCommit = await getChangedFilesForCommits(
    repoRoot,
    summaries.map((entry) => entry.commitHash),
  );
  const dirtySet = new Set(dirtyFiles);
  for (const summary of summaries) {
    const touched = filesByCommit.get(summary.commitHash) ?? [];
    const taintedFiles = touched.filter((file) => dirtySet.has(file));
    if (taintedFiles.length > 0) {
      summary.tainted = true;
      summary.taintedFiles = taintedFiles;
    }
  }

  return summaries;
};

/**
 * Hash of the most recent self-mod commit reachable from HEAD, or null
 * when no self-mod commit exists.
 */
export const getLastSelfModCommitHash = async (
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
 * Order an arbitrary set of commit hashes by topology (oldest first),
 * falling back to commit timestamps for disconnected histories. Useful
 * when an external caller (e.g. the Store agent) hands us a picked-list
 * of commits without preserving chronological order.
 *
 * The topo walk is bounded to the span between the commits' octopus
 * merge-base and the commits themselves — never a full-history
 * `rev-list --all` walk.
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
  if (entries.length === 1) {
    return entries.map((entry) => entry.hash);
  }

  const topoIndex = new Map<string, number>();
  try {
    const resolvedHashes = entries.map((entry) => entry.hash);
    // Bound the walk to commits between the selection's common ancestor
    // and the selected tips. `merge-base --octopus` fails for fully
    // disconnected histories; the timestamp fallback below covers that.
    const mergeBase = await runGit(args.repoRoot, [
      "merge-base",
      "--octopus",
      ...resolvedHashes,
    ]);
    const topoOutput = await runGit(args.repoRoot, [
      "rev-list",
      "--reverse",
      "--topo-order",
      ...resolvedHashes,
      "--not",
      mergeBase,
    ]);
    // The merge-base itself is excluded from the range; if it is one of
    // the selected commits it is by definition the oldest.
    topoIndex.set(mergeBase, -1);
    topoOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((hash, index) => topoIndex.set(hash, index));
  } catch {
    // Fall back to timestamp ordering below.
  }
  entries.sort((left, right) => {
    const leftIndex = topoIndex.get(left.hash);
    const rightIndex = topoIndex.get(right.hash);
    if (leftIndex != null && rightIndex != null && leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.timestampMs - right.timestampMs;
  });
  return entries.map((entry) => entry.hash);
};

/**
 * Detect whether new self-mod commits landed on `repoRoot` since
 * `sinceHead`. Returns a `SelfModCommitAppliedPayload` describing the most
 * recent commit so the runtime can surface an undo affordance against
 * it. Returns null when no new commits exist.
 */
export const detectSelfModAppliedSince = async (args: {
  repoRoot: string;
  sinceHead: string | null;
}): Promise<SelfModCommitAppliedPayload | null> => {
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
    isStellaSelfModCommitMessage(`${commit.subject}\n${commit.body}`),
  );
  const latest = commits[0];
  if (!latest) {
    return null;
  }

  const files = await getChangedFilesForCommit(repoRoot, latest.hash);
  return {
    commitHash: latest.hash,
    files,
    batchIndex: 0,
  };
};
