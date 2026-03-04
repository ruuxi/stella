import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

const LOG_ENTRY_SEPARATOR = "\x1e";
const LOG_FIELD_SEPARATOR = "\x1f";
const FEATURE_TAG_REGEX = /\[feature:([a-zA-Z0-9_-]+)\]/g;
const DEFAULT_LOG_SCAN_LIMIT = 500;
const DEFAULT_RECENT_FEATURE_LIMIT = 8;

const FEATURES_INDEX_PATH = path.join(
  os.homedir(),
  ".stella",
  "mods",
  "features.json",
);

type FeatureIndexEntry = {
  name?: string;
  description?: string;
  updatedAt?: number;
};

type FeatureIndex = {
  version: number;
  features: Record<string, FeatureIndexEntry>;
};

type GitLogCommit = {
  hash: string;
  timestampMs: number;
  subject: string;
  body: string;
};

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
};

export type SelfModAppliedPayload = {
  featureId: string;
  files: string[];
  batchIndex: number;
};

const humanizeFeatureId = (featureId: string): string =>
  featureId
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
    .trim() || featureId;

const normalizeGitPath = (value: string): string =>
  value.trim().replace(/\\/g, "/");

const extractFeatureIds = (text: string): string[] => {
  FEATURE_TAG_REGEX.lastIndex = 0;
  const matches = text.matchAll(FEATURE_TAG_REGEX);
  const ids = new Set<string>();
  for (const match of matches) {
    const featureId = match[1]?.trim();
    if (featureId) ids.add(featureId);
  }
  return Array.from(ids);
};

const runGit = async (
  repoRoot: string,
  args: string[],
): Promise<string> => {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const err = error as Error & {
      code?: string;
      stderr?: string;
      stdout?: string;
    };
    const details =
      err.stderr?.trim() ||
      err.stdout?.trim() ||
      err.message;
    throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
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

const readFeatureIndex = async (): Promise<FeatureIndex> => {
  try {
    const raw = await fs.readFile(FEATURES_INDEX_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FeatureIndex>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid index payload.");
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      features:
        parsed.features && typeof parsed.features === "object"
          ? parsed.features as Record<string, FeatureIndexEntry>
          : {},
    };
  } catch {
    return { version: 1, features: {} };
  }
};

const writeFeatureIndex = async (index: FeatureIndex): Promise<void> => {
  await fs.mkdir(path.dirname(FEATURES_INDEX_PATH), { recursive: true });
  await fs.writeFile(
    FEATURES_INDEX_PATH,
    JSON.stringify(index, null, 2),
    "utf-8",
  );
};

const listTaggedCommits = async (
  repoRoot: string,
  maxCount = DEFAULT_LOG_SCAN_LIMIT,
): Promise<GitLogCommit[]> => {
  const format = `%H${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%b${LOG_ENTRY_SEPARATOR}`;
  const output = await runGit(repoRoot, [
    "log",
    `--max-count=${Math.max(1, maxCount)}`,
    `--pretty=format:${format}`,
  ]);
  return parseGitLog(output);
};

const listDirtyFiles = async (repoRoot: string): Promise<string[]> => {
  const output = await runGit(repoRoot, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
  ]);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => parseStatusPath(line))
    .filter((line): line is string => Boolean(line));
};

export const getGitHead = async (repoRoot: string): Promise<string | null> => {
  await assertGitRepository(repoRoot);
  const output = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return output || null;
};

export const listRecentGitFeatures = async (
  repoRoot: string,
  limit = DEFAULT_RECENT_FEATURE_LIMIT,
): Promise<GitFeatureSummary[]> => {
  await assertGitRepository(repoRoot);
  const commits = await listTaggedCommits(repoRoot);
  const index = await readFeatureIndex();
  const nextIndex: FeatureIndex = {
    version: index.version,
    features: { ...index.features },
  };

  const byFeature = new Map<string, GitFeatureSummary>();
  const commitHashesByFeature = new Map<string, string[]>();

  for (const commit of commits) {
    const featureIds = extractFeatureIds(`${commit.subject}\n${commit.body}`);
    if (featureIds.length === 0) continue;

    for (const featureId of featureIds) {
      const hashes = commitHashesByFeature.get(featureId) ?? [];
      hashes.push(commit.hash);
      commitHashesByFeature.set(featureId, hashes);

      const existing = byFeature.get(featureId);
      if (!existing) {
        const indexEntry = index.features[featureId];
        const name = indexEntry?.name?.trim() || humanizeFeatureId(featureId);
        const description = indexEntry?.description?.trim() || "";
        byFeature.set(featureId, {
          featureId,
          name,
          description,
          latestCommit: commit.hash,
          latestTimestampMs: commit.timestampMs,
          commitCount: 1,
        });
      } else {
        existing.commitCount += 1;
      }

      if (!nextIndex.features[featureId]) {
        nextIndex.features[featureId] = {
          name: humanizeFeatureId(featureId),
          description: "",
          updatedAt: commit.timestampMs,
        };
      } else {
        nextIndex.features[featureId] = {
          ...nextIndex.features[featureId],
          updatedAt: Math.max(
            Number(nextIndex.features[featureId]?.updatedAt ?? 0),
            commit.timestampMs,
          ),
        };
      }
    }
  }

  if (JSON.stringify(index) !== JSON.stringify(nextIndex)) {
    await writeFeatureIndex(nextIndex);
  }

  const recent = Array.from(byFeature.values())
    .sort((a, b) => b.latestTimestampMs - a.latestTimestampMs)
    .slice(0, Math.max(1, limit));

  if (recent.length > 0) {
    const dirtyFiles = await listDirtyFiles(repoRoot);
    if (dirtyFiles.length > 0) {
      for (const feature of recent) {
        const touchedFiles = new Set<string>();
        const featureCommits = commitHashesByFeature.get(feature.featureId) ?? [];
        for (const commitHash of featureCommits) {
          const commitFiles = await getChangedFilesForCommit(repoRoot, commitHash);
          for (const file of commitFiles) {
            touchedFiles.add(normalizeGitPath(file));
          }
        }

        const taintedFiles = dirtyFiles.filter((file) => touchedFiles.has(file));
        if (taintedFiles.length > 0) {
          feature.tainted = true;
          feature.taintedFiles = taintedFiles;
        }
      }
    }
  }

  return recent;
};

export const getLastGitFeatureId = async (
  repoRoot: string,
): Promise<string | null> => {
  const recent = await listRecentGitFeatures(repoRoot, 1);
  return recent[0]?.featureId ?? null;
};

const listFeatureCommitHashes = async (
  repoRoot: string,
  featureId: string,
): Promise<string[]> => {
  const tag = `[feature:${featureId}]`;
  const output = await runGit(repoRoot, [
    "log",
    "--pretty=format:%H",
    "--fixed-strings",
    `--grep=${tag}`,
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

export const revertGitFeature = async (args: {
  repoRoot: string;
  featureId?: string | null;
  steps?: number;
}): Promise<GitRevertResult> => {
  const { repoRoot } = args;
  await assertGitRepository(repoRoot);

  const featureId = args.featureId?.trim() || await getLastGitFeatureId(repoRoot);
  if (!featureId) {
    throw new Error("No recent self-mod feature found to revert.");
  }

  const steps = Math.max(1, Math.floor(args.steps ?? 1));
  const commits = await listFeatureCommitHashes(repoRoot, featureId);
  if (commits.length === 0) {
    throw new Error(`No commits found for feature "${featureId}".`);
  }

  const target = commits.slice(0, steps);
  const reverted: string[] = [];

  for (const hash of target) {
    try {
      await runGit(repoRoot, ["revert", "--no-edit", hash]);
      reverted.push(hash);
    } catch (error) {
      try {
        await runGit(repoRoot, ["revert", "--abort"]);
      } catch {
        // Best effort.
      }
      throw error;
    }
  }

  return {
    featureId,
    revertedCommitHashes: reverted,
    message:
      reverted.length === 1
        ? `Reverted 1 commit for feature ${featureId}.`
        : `Reverted ${reverted.length} commits for feature ${featureId}.`,
  };
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
    `--pretty=format:${format}`,
  ]);
  const commits = parseGitLog(output);
  if (commits.length === 0) {
    return null;
  }

  for (const commit of commits) {
    const featureIds = extractFeatureIds(`${commit.subject}\n${commit.body}`);
    if (featureIds.length === 0) continue;
    const featureId = featureIds[0];
    const files = await getChangedFilesForCommit(repoRoot, commit.hash);
    const allFeatureCommits = await listFeatureCommitHashes(repoRoot, featureId);
    const newestIndex = allFeatureCommits.findIndex((hash) => hash === commit.hash);
    const batchIndex = newestIndex >= 0 ? newestIndex : 0;
    return {
      featureId,
      files,
      batchIndex,
    };
  }

  return null;
};
