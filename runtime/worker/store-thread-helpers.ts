/**
 * Store publish-time commit helpers.
 *
 * Pulled out of `runtime/worker/server.ts` because they are pure /
 * filesystem-level utilities that don't touch worker state, and they
 * collectively account for ~300 lines of the worker's bulk.
 *
 * These utilities resolve selected local feature names into source packs and
 * per-commit reference diffs for the direct Store publish pipeline.
 */
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupEnvironment } from "dugite";
import type {
  StoreReleaseCommit,
  StoreReleaseSourcePack,
} from "../contracts/index.js";
import {
  createStellaSourceChangeSet,
  createStellaSourcePack,
  hashSourceBlob,
  type StellaSourceBlob,
  type StellaSourceChange,
  type StellaSourceChangeSet,
} from "../kernel/self-mod/stella-source-control.js";
import { orderCommitHashesChronologically } from "../kernel/self-mod/git.js";
import type {
  StellaSourceHistoryStore,
  StellaSourceRevisionRecord,
} from "../kernel/storage/stella-source-history-store.js";
import type { StoreModStore } from "../kernel/storage/store-mod-store.js";

const execFileAsync = promisify(execFile);

export const normalizeStoreThreadFeatureNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];

// Paths that carry no signal for the published reference diffs and
// routinely dwarf real changes. Excluded from `git show` via pathspec
// so both the patch and the --stat header skip them.
const STORE_RELEASE_GIT_SHOW_EXCLUDE_PATHSPECS = [
  ":(exclude,glob)**/*.min.js",
  ":(exclude,glob)**/*.min.css",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/dist-electron/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob).stella/electron-user-data/**",
  ":(exclude,glob)**/*.snap",
];

const STORE_RELEASE_PER_COMMIT_DIFF_LIMIT = 200_000;
const STORE_RELEASE_SOURCE_PACK_COMMIT_LIMIT = 32;
const STORE_RELEASE_SOURCE_PACK_TEXT_FILE_LIMIT = 500_000;
const STORE_RELEASE_SOURCE_PACK_BINARY_FILE_LIMIT = 1_500_000;

const gitPathspecArgs = ["--", ...STORE_RELEASE_GIT_SHOW_EXCLUDE_PATHSPECS];

const runStoreReleaseGitShow = async (
  repoRoot: string,
  commitHash: string,
): Promise<{ subject: string; diff: string }> => {
  if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) {
    throw new Error(`Invalid commit hash: ${commitHash}`);
  }
  const { env, gitLocation } = setupEnvironment({});
  const subjectResult = await execFileAsync(
    gitLocation,
    ["show", "-s", "--format=%s", "--no-color", commitHash],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 1 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const subjectStdout = subjectResult.stdout;
  const subject = subjectStdout.trim() || `(no subject)`;
  const diffResult = await execFileAsync(
    gitLocation,
    [
      "show",
      "-U10",
      "--patch",
      "--find-renames",
      "--no-color",
      commitHash,
      ...gitPathspecArgs,
    ],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const diffStdout = diffResult.stdout;
  const trimmed = diffStdout.trim() || `(empty commit ${commitHash})`;
  const diff =
    trimmed.length <= STORE_RELEASE_PER_COMMIT_DIFF_LIMIT
      ? trimmed
      : `${trimmed.slice(0, STORE_RELEASE_PER_COMMIT_DIFF_LIMIT)}\n... [truncated]`;
  return { subject, diff };
};

const runStoreReleaseGit = async (
  repoRoot: string,
  args: string[],
  options?: { encoding?: "utf8" | "buffer"; maxBuffer?: number },
): Promise<{
  status: number;
  stdout: string | Buffer;
  stderr: string | Buffer;
}> => {
  const { env, gitLocation } = setupEnvironment({});
  const encoding = options?.encoding === "buffer" ? "buffer" : "utf8";
  try {
    const result = await execFileAsync(gitLocation, args, {
      cwd: repoRoot,
      env,
      encoding,
      maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const err = error as {
      code?: unknown;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
      stderr: err.stderr ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
    };
  }
};

const bufferLooksText = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  if (decoded.includes("\uFFFD")) return false;
  return true;
};

const blobFromGitBuffer = (
  buffer: Buffer,
  redactor: (input: string) => string,
): { blob: StellaSourceBlob; redacted: boolean } => {
  if (bufferLooksText(buffer)) {
    const decoded = buffer.toString("utf8");
    const redacted = redactor(decoded);
    return {
      blob: { kind: "text", content: redacted },
      redacted: redacted !== decoded,
    };
  }
  return {
    blob: { kind: "binary", contentBase64: buffer.toString("base64") },
    redacted: false,
  };
};

type StoreReleaseGitBlobRead = {
  blob?: StellaSourceBlob;
  redacted: boolean;
  contentOmitted: boolean;
};

const gitStdoutText = (value: string | Buffer): string =>
  typeof value === "string" ? value : value.toString("utf8");

const readStoreReleaseGitBlob = async (args: {
  repoRoot: string;
  revision: string;
  filePath: string;
  redactor: (input: string) => string;
}): Promise<StoreReleaseGitBlobRead> => {
  const objectResult = await runStoreReleaseGit(args.repoRoot, [
    "rev-parse",
    `${args.revision}:${args.filePath}`,
  ]);
  if (objectResult.status !== 0) {
    return { redacted: false, contentOmitted: false };
  }
  const objectId = gitStdoutText(objectResult.stdout).trim();
  if (!objectId) {
    return { redacted: false, contentOmitted: true };
  }
  const sizeResult = await runStoreReleaseGit(args.repoRoot, [
    "cat-file",
    "-s",
    objectId,
  ]);
  if (sizeResult.status !== 0) {
    return { redacted: false, contentOmitted: true };
  }
  const size = Number(gitStdoutText(sizeResult.stdout).trim());
  if (
    !Number.isFinite(size) ||
    size < 0 ||
    size > STORE_RELEASE_SOURCE_PACK_BINARY_FILE_LIMIT
  ) {
    return { redacted: false, contentOmitted: true };
  }
  const result = await runStoreReleaseGit(
    args.repoRoot,
    ["show", `${args.revision}:${args.filePath}`],
    {
      encoding: "buffer",
      maxBuffer: STORE_RELEASE_SOURCE_PACK_BINARY_FILE_LIMIT + 1024,
    },
  );
  if (result.status !== 0) {
    return { redacted: false, contentOmitted: true };
  }
  const buffer = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout);
  if (
    bufferLooksText(buffer) &&
    buffer.length > STORE_RELEASE_SOURCE_PACK_TEXT_FILE_LIMIT
  ) {
    return { redacted: false, contentOmitted: true };
  }
  if (
    !bufferLooksText(buffer) &&
    buffer.length > STORE_RELEASE_SOURCE_PACK_BINARY_FILE_LIMIT
  ) {
    return { redacted: false, contentOmitted: true };
  }
  return { ...blobFromGitBuffer(buffer, args.redactor), contentOmitted: false };
};

const listStoreReleaseCommitFiles = async (
  repoRoot: string,
  commitHash: string,
): Promise<string[]> => {
  const result = await runStoreReleaseGit(repoRoot, [
    "show",
    "--name-only",
    "--pretty=format:",
    "--no-renames",
    commitHash,
    ...gitPathspecArgs,
  ]);
  if (result.status !== 0) {
    const detail =
      (typeof result.stderr === "string"
        ? result.stderr
        : result.stderr.toString("utf8")
      ).trim() ||
      (typeof result.stdout === "string"
        ? result.stdout
        : result.stdout.toString("utf8")
      ).trim() ||
      `exit code ${result.status}`;
    throw new Error(`Could not list files for ${commitHash}: ${detail}`);
  }
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout
      : result.stdout.toString("utf8");
  return Array.from(
    new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ),
  ).sort();
};

/**
 * Best-effort redactor for text leaving the author's machine. Scrubs
 * `$HOME` paths, the local username when it appears in path-shaped
 * contexts, JWT/OAuth/SSH credential shapes, email addresses outside
 * obvious test fixtures, and bearer-token assignments. The reviewer
 * still rejects on anything the regex misses.
 */
export const buildStoreReleaseRedactor = (): ((input: string) => string) => {
  const home = os.homedir();
  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return null;
    }
  })();

  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const homeMatchers: RegExp[] = [];
  if (home && home.length > 1) {
    homeMatchers.push(new RegExp(escapeRegex(home), "g"));
  }

  const usernameMatchers: RegExp[] = [];
  if (username && username.length > 1) {
    const escapedUsername = escapeRegex(username);
    // Replace username only when it appears inside a path-shaped
    // context (after `/`, `\\`, or `/Users/`). Bare-word username can
    // false-positive on real content; we leave that to the reviewer.
    usernameMatchers.push(new RegExp(`/Users/${escapedUsername}\\b`, "g"));
    usernameMatchers.push(new RegExp(`/home/${escapedUsername}\\b`, "g"));
    usernameMatchers.push(
      new RegExp(`\\\\Users\\\\${escapedUsername}\\b`, "g"),
    );
  }

  const credentialPatterns: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9_-]{20,}/g, "<redacted-token>"],
    [/sk-ant-[A-Za-z0-9_-]{20,}/g, "<redacted-token>"],
    [/xoxb-[A-Za-z0-9-]{20,}/g, "<redacted-token>"],
    [/xoxp-[A-Za-z0-9-]{20,}/g, "<redacted-token>"],
    [/ghp_[A-Za-z0-9]{20,}/g, "<redacted-token>"],
    [/gho_[A-Za-z0-9]{20,}/g, "<redacted-token>"],
    [/github_pat_[A-Za-z0-9_]{20,}/g, "<redacted-token>"],
    [/AKIA[0-9A-Z]{16}/g, "<redacted-token>"],
    [/AIza[0-9A-Za-z_-]{30,}/g, "<redacted-token>"],
    [
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      "<redacted-jwt>",
    ],
    [
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
      "<redacted-private-key>",
    ],
    [/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer <redacted-token>"],
  ];

  return (input: string): string => {
    let result = input;
    for (const matcher of homeMatchers) {
      result = result.replace(matcher, "~");
    }
    for (const matcher of usernameMatchers) {
      result = result.replace(matcher, (full) =>
        full.replace(username ?? "", "<user>"),
      );
    }
    for (const [pattern, replacement] of credentialPatterns) {
      result = result.replace(pattern, replacement);
    }
    return result;
  };
};

const collectStoreReleaseCommitHashes = async (args: {
  repoRoot: string;
  attachedFeatureNames: string[];
  snapshot: ReturnType<StoreModStore["readFeatureSnapshot"]>;
}): Promise<string[]> => {
  if (args.attachedFeatureNames.length === 0) return [];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const name of args.attachedFeatureNames) {
    const item = args.snapshot?.items.find((entry) => entry.name === name);
    for (const rawHash of item?.commitHashes ?? []) {
      const hash = rawHash.trim();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      selected.push(hash);
    }
  }
  if (selected.length === 0) return [];
  return await orderCommitHashesChronologically({
    repoRoot: args.repoRoot,
    commitHashes: selected,
  });
};

export const collectStoreReleaseCommits = async (args: {
  repoRoot: string;
  attachedFeatureNames: string[];
  snapshot: ReturnType<StoreModStore["readFeatureSnapshot"]>;
}): Promise<StoreReleaseCommit[]> => {
  const ordered = await collectStoreReleaseCommitHashes(args);
  if (ordered.length === 0) return [];
  const redact = buildStoreReleaseRedactor();
  const commits: StoreReleaseCommit[] = [];
  for (const hash of ordered) {
    const { subject, diff } = await runStoreReleaseGitShow(args.repoRoot, hash);
    commits.push({
      hash,
      subject: redact(subject),
      diff: redact(diff),
    });
  }
  return commits;
};

export const collectStoreReleaseSourcePack = async (args: {
  repoRoot: string;
  attachedFeatureNames: string[];
  snapshot: ReturnType<StoreModStore["readFeatureSnapshot"]>;
  sourceHistory?: StellaSourceHistoryStore | null;
}): Promise<StoreReleaseSourcePack | undefined> => {
  const ordered = await collectStoreReleaseCommitHashes(args);
  if (ordered.length === 0) return undefined;
  if (ordered.length > STORE_RELEASE_SOURCE_PACK_COMMIT_LIMIT) {
    return undefined;
  }

  const historyBacked = args.sourceHistory
    ? await collectStoreReleaseSourcePackFromHistory({
        repoRoot: args.repoRoot,
        attachedFeatureNames: args.attachedFeatureNames,
        orderedCommitHashes: ordered,
        sourceHistory: args.sourceHistory,
      })
    : undefined;
  if (historyBacked) {
    return historyBacked;
  }

  const redact = buildStoreReleaseRedactor();
  let baseRevisionId: string | null = null;
  let parentRevisionId: string | null = null;
  const changeSets: StellaSourceChangeSet[] = [];

  for (const hash of ordered) {
    const parentResult = await runStoreReleaseGit(args.repoRoot, [
      "rev-parse",
      `${hash}^`,
    ]);
    if (parentResult.status !== 0) {
      return undefined;
    }
    const parentHash =
      typeof parentResult.stdout === "string"
        ? parentResult.stdout.trim()
        : parentResult.stdout.toString("utf8").trim();
    if (!parentHash) return undefined;
    if (!baseRevisionId) {
      baseRevisionId = `git:${parentHash}`;
      parentRevisionId = baseRevisionId;
    }

    const { subject } = await runStoreReleaseGitShow(args.repoRoot, hash);
    const files = await listStoreReleaseCommitFiles(args.repoRoot, hash);
    const changes: StellaSourceChange[] = [];
    for (const filePath of files) {
      const base = await readStoreReleaseGitBlob({
        repoRoot: args.repoRoot,
        revision: `${hash}^`,
        filePath,
        redactor: redact,
      });
      const next = await readStoreReleaseGitBlob({
        repoRoot: args.repoRoot,
        revision: hash,
        filePath,
        redactor: redact,
      });
      if (
        base.redacted ||
        next.redacted ||
        base.contentOmitted ||
        next.contentOmitted
      ) {
        return undefined;
      }
      const baseHash = hashSourceBlob(base.blob);
      const nextHash = hashSourceBlob(next.blob);
      if (baseHash === nextHash) continue;
      changes.push({
        path: filePath,
        baseHash,
        nextHash,
        ...(base.blob ? { base: base.blob } : {}),
        ...(next.blob ? { next: next.blob } : {}),
      });
    }
    const changeSet = createStellaSourceChangeSet({
      baseRevisionId: parentRevisionId ?? `git:${parentHash}`,
      parentRevisionIds: [parentRevisionId ?? `git:${parentHash}`],
      description: redact(subject),
      changes,
    });
    changeSets.push(changeSet);
    parentRevisionId = changeSet.revisionId;
  }

  if (!baseRevisionId || changeSets.length === 0) return undefined;
  return createStellaSourcePack({
    baseRevisionId,
    description: args.attachedFeatureNames.join(", "),
    changeSets,
  }) as StoreReleaseSourcePack;
};

const collectStoreReleaseSourcePackFromHistory = async (args: {
  repoRoot: string;
  attachedFeatureNames: string[];
  orderedCommitHashes: string[];
  sourceHistory: StellaSourceHistoryStore;
}): Promise<StoreReleaseSourcePack | undefined> => {
  const records: StellaSourceRevisionRecord[] = [];
  for (const hash of args.orderedCommitHashes) {
    const record = args.sourceHistory.findRevisionByCommit(hash);
    if (!record) return undefined;
    records.push(record);
  }
  if (records.length === 0) return undefined;

  const redact = buildStoreReleaseRedactor();
  const changeSets: StellaSourceChangeSet[] = [];
  for (const record of records) {
    if (!record.commitHash) return undefined;
    const parentResult = await runStoreReleaseGit(args.repoRoot, [
      "rev-parse",
      `${record.commitHash}^`,
    ]);
    if (parentResult.status !== 0) return undefined;
    const parentHash =
      typeof parentResult.stdout === "string"
        ? parentResult.stdout.trim()
        : parentResult.stdout.toString("utf8").trim();
    if (!parentHash) return undefined;

    const changes: StellaSourceChange[] = [];
    for (const change of record.changeSet.changes) {
      const base = await readStoreReleaseGitBlob({
        repoRoot: args.repoRoot,
        revision: `${record.commitHash}^`,
        filePath: change.path,
        redactor: redact,
      });
      const next = await readStoreReleaseGitBlob({
        repoRoot: args.repoRoot,
        revision: record.commitHash,
        filePath: change.path,
        redactor: redact,
      });
      if (
        base.redacted ||
        next.redacted ||
        base.contentOmitted ||
        next.contentOmitted
      ) {
        return undefined;
      }
      const baseHash = hashSourceBlob(base.blob);
      const nextHash = hashSourceBlob(next.blob);
      if (baseHash !== change.baseHash || nextHash !== change.nextHash) {
        return undefined;
      }
      changes.push({
        path: change.path,
        baseHash,
        nextHash,
        ...(base.blob ? { base: base.blob } : {}),
        ...(next.blob ? { next: next.blob } : {}),
      });
    }

    const changeSet = createStellaSourceChangeSet({
      baseRevisionId: record.changeSet.baseRevisionId,
      parentRevisionIds: record.changeSet.parentRevisionIds,
      ...(record.changeSet.featureId
        ? { featureId: record.changeSet.featureId }
        : {}),
      ...(record.changeSet.description
        ? { description: record.changeSet.description }
        : {}),
      changes,
    });
    if (changeSet.revisionId !== record.revisionId) {
      return undefined;
    }
    changeSets.push(changeSet);
  }

  return createStellaSourcePack({
    baseRevisionId: records[0]!.baseRevisionId,
    description: args.attachedFeatureNames.join(", "),
    changeSets,
  }) as StoreReleaseSourcePack;
};
