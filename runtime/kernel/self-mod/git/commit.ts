import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitRepository,
  normalizePathspecs,
  runGit,
  runGitStatus,
  runGitWithEnv,
  runGitWithEnvStatus,
  toTrimmedString,
} from "./exec.js";
import { withRepoCommitLock } from "./commit-lock.js";
import { getGitHead } from "./log.js";

/**
 * Dependency manifest/lock files that should follow the changes the
 * agent makes (e.g. `bun install` updating `bun.lock`). Returns only
 * the files that exist in the repo. Callers MUST further filter against
 * the run's baseline dirty set before staging — staging unconditionally
 * sweeps in unrelated user work.
 */
export const listDependencyFiles = async (
  repoRoot: string,
): Promise<string[]> => {
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
  const result = await runGitStatus(repoRoot, [
    "diff",
    "--cached",
    "--quiet",
    "--exit-code",
  ]);
  if (result.exitCode === 0) {
    return false;
  }
  if (result.exitCode === 1) {
    return true;
  }
  const details =
    toTrimmedString(result.stderr) ||
    toTrimmedString(result.stdout) ||
    `exit code ${result.exitCode}`;
  throw new Error(
    `Git command failed (diff --cached --quiet --exit-code): ${details}`,
  );
};

const commitPathScopedChanges = async (
  repoRoot: string,
  paths: string[],
  commitArgs: string[],
  shouldCommit?: () => boolean,
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
      const details =
        diff.stderr || diff.stdout || `exit code ${diff.exitCode}`;
      throw new Error(
        `Git command failed (diff --cached --quiet -- <paths>): ${details}`,
      );
    }

    if (shouldCommit && !shouldCommit()) {
      return null;
    }
    await runGitWithEnv(repoRoot, commitArgs, env);
    // The temporary index produced the commit; refresh only these paths in the
    // real index so unrelated staged user changes remain untouched.
    await runGit(repoRoot, ["reset", "-q", "--", ...paths]);
    return await getGitHead(repoRoot);
  } finally {
    await fs
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
};

/**
 * Return a truncated unified diff for the changes about to be committed.
 *
 * Used to prompt the modifying agent for a commit message without sending
 * unbounded patch bytes through the LLM. We cap line count rather than byte
 * count because the model only needs an overview of edits.
 *
 * When `paths` is provided (the self-mod path), we diff the working tree
 * against `HEAD` scoped to those paths — this matches what the path-scoped
 * commit will end up committing. Otherwise we fall back to the staged diff.
 */
export const getStagedDiffPreview = async (
  repoRoot: string,
  options?: { maxLines?: number; paths?: string[] },
): Promise<string> => {
  const maxLines = Math.max(20, options?.maxLines ?? 400);
  const paths = normalizePathspecs(options?.paths);
  const diffArgs: string[] =
    paths.length > 0
      ? [
          "diff",
          "HEAD",
          "--unified=2",
          "--no-color",
          "--stat-width=120",
          "--",
          ...paths,
        ]
      : ["diff", "--cached", "--unified=2", "--no-color", "--stat-width=120"];
  const raw = await runGit(repoRoot, diffArgs);
  if (!raw) return "";
  const lines = raw.split("\n");
  if (lines.length <= maxLines) {
    return raw;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n... [diff truncated, ${lines.length - maxLines} more lines]`;
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
  /**
   * Last-moment ownership check, evaluated inside the repository commit lock
   * after the isolated index is prepared and immediately before `git commit`.
   * A canceled self-mod finalizer uses this to prevent a stale async finalize
   * from committing newer work under its old identity.
   */
  shouldCommit?: () => boolean;
};

const SUBJECT_MAX_LENGTH = 72;

const sanitizeCommitSubject = (raw: string): string => {
  const cleaned = raw.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
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
 * Commit currently-staged changes (or, with `paths`, a path-scoped set
 * of working-tree changes through an isolated index) with a free-form,
 * agent-authored message.
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
  // Serialize the ref-updating region per repo so concurrent agent commits
  // (all in the shared worker process) queue instead of colliding on the HEAD
  // ref lock. The staged-changes checks above are read-only and safe outside
  // the lock; only the commit + HEAD read need the critical section.
  return await withRepoCommitLock(args.repoRoot, async () => {
    if (paths.length > 0) {
      return await commitPathScopedChanges(
        args.repoRoot,
        paths,
        commitArgs,
        args.shouldCommit,
      );
    }

    if (args.shouldCommit && !args.shouldCommit()) {
      return null;
    }
    await runGit(args.repoRoot, commitArgs);
    return await getGitHead(args.repoRoot);
  });
};
