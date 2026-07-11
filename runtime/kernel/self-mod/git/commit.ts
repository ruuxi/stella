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
import { recordSelfModCommitInLedger } from "../applied-ledger.js";
import type { LogicalFileState } from "../logical-change-set.js";

export type ExactGitFileState = {
  path: string;
  state: LogicalFileState;
};

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

const gitEntryIdentity = (raw: string | Buffer): string => {
  const value = toTrimmedString(raw);
  const match = value.match(/^(\d{6})\s+(?:blob\s+)?([0-9a-f]{40,64})/);
  return match ? `${match[1]}:${match[2]}` : "";
};

class GitHeadMovedError extends Error {
  constructor() {
    super("Git HEAD moved during exact self-mod commit.");
    this.name = "GitHeadMovedError";
  }
}

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
      const details =
        diff.stderr || diff.stdout || `exit code ${diff.exitCode}`;
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
    await fs
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
};

export const readGitHeadFileState = async (
  repoRoot: string,
  repoRelativePath: string,
): Promise<LogicalFileState> => {
  const entry = await runGitStatus(
    repoRoot,
    ["ls-tree", "-z", "HEAD", "--", repoRelativePath],
    { encoding: "buffer" },
  );
  if (entry.exitCode !== 0 || Buffer.from(entry.stdout).length === 0) {
    return { kind: "missing" };
  }
  const header =
    Buffer.from(entry.stdout).toString("utf8").split("\0")[0] ?? "";
  const match = header.match(
    /^(100644|100755|120000)\s+blob\s+([0-9a-f]{40,64})\t/,
  );
  if (!match) return { kind: "missing" };
  const mode = match[1] as "100644" | "100755" | "120000";
  const object = await runGitStatus(repoRoot, ["cat-file", "blob", match[2]!], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (object.exitCode !== 0) throw new Error("Failed to read HEAD blob.");
  const bytes = Buffer.from(object.stdout);
  const candidateText = bytes.toString("utf8");
  const text =
    !bytes.includes(0) && Buffer.from(candidateText, "utf8").equals(bytes)
      ? candidateText
      : undefined;
  return {
    kind: mode === "120000" ? "symlink" : "blob",
    mode,
    contentBase64: bytes.toString("base64"),
    ...(mode !== "120000" && text !== undefined ? { text } : {}),
  };
};

const commitExactFileStates = async (
  repoRoot: string,
  files: ExactGitFileState[],
  commitArgs: string[],
): Promise<string | null> => {
  if (files.length === 0) return null;
  const expectedHead = await getGitHead(repoRoot);
  if (!expectedHead) throw new Error("Exact self-mod commit requires HEAD.");
  const originalIndexEntries = new Map<string, string>();
  const originalHeadEntries = new Map<string, string>();
  for (const file of files) {
    const [indexEntry, headEntry] = await Promise.all([
      runGitStatus(repoRoot, ["ls-files", "--stage", "--", file.path]),
      runGitStatus(repoRoot, ["ls-tree", expectedHead, "--", file.path]),
    ]);
    originalIndexEntries.set(file.path, gitEntryIdentity(indexEntry.stdout));
    originalHeadEntries.set(file.path, gitEntryIdentity(headEntry.stdout));
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-git-index-"));
  const indexPath = path.join(tempDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  const nextEntries = new Map<string, { mode: string; blob: string } | null>();
  try {
    await runGitWithEnv(repoRoot, ["read-tree", expectedHead], env);
    for (const [index, file] of files.entries()) {
      if (file.state.kind === "missing") {
        await runGitWithEnvStatus(
          repoRoot,
          ["update-index", "--force-remove", "--", file.path],
          env,
        );
        nextEntries.set(file.path, null);
        continue;
      }
      const blobFile = path.join(tempDir, `blob-${index}`);
      await fs.writeFile(
        blobFile,
        Buffer.from(file.state.contentBase64, "base64"),
      );
      const blob = await runGitWithEnv(
        repoRoot,
        ["hash-object", "-w", blobFile],
        env,
      );
      await runGitWithEnv(
        repoRoot,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `${file.state.mode},${blob},${file.path}`,
        ],
        env,
      );
      nextEntries.set(file.path, { mode: file.state.mode, blob });
    }
    const diff = await runGitWithEnvStatus(
      repoRoot,
      ["diff", "--cached", "--quiet"],
      env,
    );
    if (diff.exitCode === 0) return null;
    if (diff.exitCode !== 1) {
      throw new Error(
        diff.stderr || diff.stdout || "Exact self-mod diff failed.",
      );
    }
    const tree = await runGitWithEnv(repoRoot, ["write-tree"], env);
    const commitHash = await runGitWithEnv(
      repoRoot,
      ["commit-tree", tree, "-p", expectedHead, ...commitArgs.slice(1)],
      env,
    );
    const updateRef = await runGitStatus(repoRoot, [
      "update-ref",
      "HEAD",
      commitHash,
      expectedHead,
    ]);
    if (updateRef.exitCode !== 0) throw new GitHeadMovedError();

    // Advance only clean real-index entries. Any entry that differed from the
    // old HEAD was user-staged and must remain byte-for-byte untouched.
    for (const file of files) {
      const currentIndexEntry = await runGitStatus(repoRoot, [
        "ls-files",
        "--stage",
        "--",
        file.path,
      ]);
      if (
        originalIndexEntries.get(file.path) !==
          originalHeadEntries.get(file.path) ||
        gitEntryIdentity(currentIndexEntry.stdout) !==
          originalIndexEntries.get(file.path)
      ) {
        continue;
      }
      const next = nextEntries.get(file.path);
      if (!next) {
        await runGitWithEnvStatus(
          repoRoot,
          ["update-index", "--force-remove", "--", file.path],
          {},
        );
      } else {
        await runGit(repoRoot, [
          "update-index",
          "--add",
          "--cacheinfo",
          `${next.mode},${next.blob},${file.path}`,
        ]);
      }
    }
    return commitHash;
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
  /** Exact merged states to commit instead of reading shared working-tree bytes. */
  files?: ExactGitFileState[] | (() => Promise<ExactGitFileState[]>);
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
  if (
    !args.files &&
    paths.length === 0 &&
    !(await hasStagedChanges(args.repoRoot))
  ) {
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
  let committedPaths: string[] = paths;
  const commitHash = await withRepoCommitLock(args.repoRoot, async () => {
    if (args.files) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const files =
          typeof args.files === "function" ? await args.files() : args.files;
        try {
          const hash = await commitExactFileStates(
            args.repoRoot,
            files,
            commitArgs,
          );
          committedPaths = files.map((file) => file.path);
          return hash;
        } catch (error) {
          if (!(error instanceof GitHeadMovedError) || attempt === 2)
            throw error;
        }
      }
      throw new Error("Exact self-mod commit retry exhausted.");
    }
    if (paths.length > 0) {
      return await commitPathScopedChanges(args.repoRoot, paths, commitArgs);
    }

    await runGit(args.repoRoot, commitArgs);
    return await getGitHead(args.repoRoot);
  });
  if (commitHash) {
    // Push-based self-mod detection: run finalization reads this ledger
    // instead of scanning git history, so the fact that a self-mod commit
    // landed must be recorded at the moment of creation. The ledger applies
    // the same trailer filter the git scan used; non-self-mod commits
    // routed through this committer are ignored there.
    recordSelfModCommitInLedger({
      commitHash,
      files: committedPaths,
      message: [subject, body, trailerLines.join("\n")]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  return commitHash;
};
