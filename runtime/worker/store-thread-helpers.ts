/**
 * Store publish-time commit helpers.
 *
 * These utilities resolve selected local feature names into sanitized git
 * object artifacts and reference diffs for the direct Store publish pipeline.
 */
import os from "node:os";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { setupEnvironment } from "dugite";
import type {
  StoreReleaseCommit,
  StoreReleaseGitArtifact,
  StoreReleaseGitObjectUpload,
} from "../contracts/index.js";
import { orderCommitHashesChronologically } from "../kernel/self-mod/git.js";
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
const STORE_RELEASE_GIT_ARTIFACT_COMMIT_LIMIT = 32;
const STORE_RELEASE_GIT_TEXT_FILE_LIMIT = 1_500_000;
const STORE_RELEASE_GIT_OBJECT_CONTENT_LIMIT = 50 * 1024 * 1024;

const gitPathspecArgs = ["--", ...STORE_RELEASE_GIT_SHOW_EXCLUDE_PATHSPECS];

const gitStdoutText = (value: string | Buffer): string =>
  typeof value === "string" ? value : value.toString("utf8");

const bufferLooksText = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) return false;
  return !buffer.toString("utf8").includes("\uFFFD");
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

const runStoreReleaseGitOrThrow = async (
  repoRoot: string,
  args: string[],
  options?: { encoding?: "utf8" | "buffer"; maxBuffer?: number },
): Promise<string | Buffer> => {
  const result = await runStoreReleaseGit(repoRoot, args, options);
  if (result.status === 0) return result.stdout;
  const detail =
    gitStdoutText(result.stderr).trim() ||
    gitStdoutText(result.stdout).trim() ||
    `exit code ${result.status}`;
  throw new Error(`Git command failed (${args.join(" ")}): ${detail}`);
};

const runStoreReleaseGitShow = async (
  repoRoot: string,
  commitHash: string,
): Promise<{ subject: string; diff: string }> => {
  if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) {
    throw new Error(`Invalid commit hash: ${commitHash}`);
  }
  const subject = gitStdoutText(
    await runStoreReleaseGitOrThrow(repoRoot, [
      "show",
      "-s",
      "--format=%s",
      "--no-color",
      commitHash,
    ]),
  ).trim();
  const rawDiff = gitStdoutText(
    await runStoreReleaseGitOrThrow(
      repoRoot,
      [
        "show",
        "-U10",
        "--patch",
        "--find-renames",
        "--format=",
        "--no-color",
        commitHash,
        ...gitPathspecArgs,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    ),
  ).trim();
  const diff = rawDiff || `(empty commit ${commitHash})`;
  return {
    subject: subject || "(no subject)",
    diff:
      diff.length <= STORE_RELEASE_PER_COMMIT_DIFF_LIMIT
        ? diff
        : `${diff.slice(0, STORE_RELEASE_PER_COMMIT_DIFF_LIMIT)}\n... [truncated]`,
  };
};

const parseNulList = (raw: string | Buffer): string[] =>
  gitStdoutText(raw)
    .split("\0")
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter(Boolean);

const isGitCommit = async (
  repoRoot: string,
  commitHash: string,
): Promise<boolean> => {
  if (!/^[0-9a-f]{40}$/i.test(commitHash)) return false;
  const result = await runStoreReleaseGit(repoRoot, [
    "cat-file",
    "-e",
    `${commitHash}^{commit}`,
  ]);
  return result.status === 0;
};

const readInstallManifestDesktopCommit = async (
  repoRoot: string,
): Promise<string | null> => {
  try {
    const parsed = JSON.parse(
      await fsPromises.readFile(path.join(repoRoot, "stella-install.json"), "utf8"),
    ) as {
      desktopReleaseCommit?: unknown;
      installState?: { desktopReleaseCommit?: unknown };
    };
    const commit =
      typeof parsed.installState?.desktopReleaseCommit === "string"
        ? parsed.installState.desktopReleaseCommit.trim()
        : typeof parsed.desktopReleaseCommit === "string"
          ? parsed.desktopReleaseCommit.trim()
          : "";
    return commit || null;
  } catch {
    return null;
  }
};

const resolveStorePublishCanonicalBase = async (args: {
  repoRoot: string;
  firstSelectedCommit: string;
}): Promise<string> => {
  const installCommit = await readInstallManifestDesktopCommit(args.repoRoot);
  if (installCommit && (await isGitCommit(args.repoRoot, installCommit))) {
    return installCommit;
  }

  for (const ref of [
    "origin/release",
    "origin/main",
    "origin/master",
    "release",
    "main",
    "master",
  ]) {
    const mergeBase = await runStoreReleaseGit(args.repoRoot, [
      "merge-base",
      args.firstSelectedCommit,
      ref,
    ]);
    const commit = gitStdoutText(mergeBase.stdout).trim();
    if (mergeBase.status === 0 && (await isGitCommit(args.repoRoot, commit))) {
      return commit;
    }
  }

  throw new Error(
    "Store publish could not resolve the canonical Stella release base. Make sure stella-install.json has desktopReleaseCommit or the repo has a release/main branch.",
  );
};

const BLOCKED_STORE_PUBLISH_PATHS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/i,
  /(^|\/)(?:credentials|credential|secrets?|tokens?)\.(?:json|ya?ml|toml|ini|env)$/i,
  /(^|\/)(?:service-account|client-secret|oauth-client).*\.(?:json|ya?ml)$/i,
  /(^|\/).*(?:private[-_]?key|refresh[-_]?token|access[-_]?token).*\.(?:json|txt|pem)$/i,
];

const OMIT_STORE_PUBLISH_PATHS: RegExp[] = [
  /(^|\/)\.DS_Store$/i,
  /(^|\/)(?:tmp|temp|cache|logs?)\//i,
  /\.(?:log|sqlite|sqlite3|db|pid|sock)$/i,
  /(^|\/)\.stella\/electron-user-data\//i,
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    "private key",
  ],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "API key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "Slack token"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "JWT"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi, "bearer token"],
  [
    /\b(?:api[_-]?key|secret|password|passwd|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?token)\b\s*[:=]\s*["'][^"']{12,}["']/gi,
    "credential assignment",
  ],
];

const pathMatches = (filePath: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(filePath));

const firstSecretFinding = (content: string): string | null => {
  for (const [pattern, label] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return label;
  }
  return null;
};

const removeStorePublishPath = async (
  worktreeRoot: string,
  filePath: string,
): Promise<void> => {
  await fsPromises.rm(path.join(worktreeRoot, filePath), {
    recursive: true,
    force: true,
  });
  await runStoreReleaseGit(worktreeRoot, [
    "rm",
    "-r",
    "--cached",
    "--ignore-unmatch",
    "--",
    filePath,
  ]);
};

const sanitizeStorePublishWorktree = async (args: {
  worktreeRoot: string;
  baseCommit: string;
  redactor: (input: string) => string;
}): Promise<{
  redactedPaths: string[];
  omittedPaths: string[];
  warnings: string[];
}> => {
  const changed = parseNulList(
    await runStoreReleaseGitOrThrow(args.worktreeRoot, [
      "diff",
      "--name-only",
      "-z",
      args.baseCommit,
      ...gitPathspecArgs,
    ]),
  );
  const redactedPaths = new Set<string>();
  const omittedPaths = new Set<string>();
  const warnings = new Set<string>();

  for (const filePath of changed) {
    if (pathMatches(filePath, BLOCKED_STORE_PUBLISH_PATHS)) {
      throw new Error(
        `Store publish blocked ${filePath} because it looks like a credential or secret file. Move private values to Settings or a connection before publishing.`,
      );
    }
    if (pathMatches(filePath, OMIT_STORE_PUBLISH_PATHS)) {
      await removeStorePublishPath(args.worktreeRoot, filePath);
      omittedPaths.add(filePath);
      continue;
    }
    const absolutePath = path.join(args.worktreeRoot, filePath);
    const stat = await fsPromises.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    if (stat.size > STORE_RELEASE_GIT_TEXT_FILE_LIMIT) {
      warnings.add(`${filePath} is large and will be reviewed as a git object.`);
      continue;
    }
    const buffer = await fsPromises.readFile(absolutePath);
    if (!bufferLooksText(buffer)) continue;
    const decoded = buffer.toString("utf8");
    const secretFinding = firstSecretFinding(decoded);
    if (secretFinding) {
      throw new Error(
        `Store publish blocked ${filePath} because it appears to contain a ${secretFinding}. Move private values to Settings or a connection before publishing.`,
      );
    }
    const redacted = args.redactor(decoded);
    if (redacted !== decoded) {
      await fsPromises.writeFile(absolutePath, redacted, "utf8");
      redactedPaths.add(filePath);
    }
  }

  await runStoreReleaseGitOrThrow(args.worktreeRoot, ["add", "-A"]);
  return {
    redactedPaths: [...redactedPaths].sort(),
    omittedPaths: [...omittedPaths].sort(),
    warnings: [...warnings].sort(),
  };
};

const readCompressedGitObject = async (
  repoRoot: string,
  sha: string,
): Promise<StoreReleaseGitObjectUpload> => {
  const type = gitStdoutText(
    await runStoreReleaseGitOrThrow(repoRoot, ["cat-file", "-t", sha]),
  ).trim();
  if (type !== "blob" && type !== "tree" && type !== "commit") {
    throw new Error(`Unsupported Store Git object type ${type} for ${sha}.`);
  }
  const contentSizeText = gitStdoutText(
    await runStoreReleaseGitOrThrow(repoRoot, ["cat-file", "-s", sha]),
  ).trim();
  const contentSize = Number(contentSizeText);
  if (
    !Number.isInteger(contentSize) ||
    contentSize < 0 ||
    contentSize > STORE_RELEASE_GIT_OBJECT_CONTENT_LIMIT
  ) {
    throw new Error(
      `Store publish cannot include ${sha}: git object content is too large. Remove large binary assets from the selected feature and try again.`,
    );
  }
  const raw = await runStoreReleaseGitOrThrow(
    repoRoot,
    ["cat-file", type, sha],
    { encoding: "buffer", maxBuffer: STORE_RELEASE_GIT_OBJECT_CONTENT_LIMIT + 1024 },
  );
  const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const storeBytes = Buffer.concat([
    Buffer.from(`${type} ${content.length}\0`, "utf8"),
    content,
  ]);
  const computed = createHash("sha1").update(storeBytes).digest("hex");
  if (computed !== sha) {
    throw new Error(`Git object integrity failed for ${sha}.`);
  }
  const compressedBytes = deflateSync(storeBytes);
  return { sha, type, sizeBytes: compressedBytes.byteLength, compressedBytes };
};

const listStoreGitArtifactObjects = async (args: {
  worktreeRoot: string;
  baseCommit: string;
  featureCommit: string;
}): Promise<StoreReleaseGitObjectUpload[]> => {
  const raw = gitStdoutText(
    await runStoreReleaseGitOrThrow(args.worktreeRoot, [
      "rev-list",
      "--objects",
      `${args.baseCommit}..${args.featureCommit}`,
    ]),
  );
  const shas = Array.from(
    new Set(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
        .filter((sha) => /^[0-9a-f]{40}$/i.test(sha)),
    ),
  );
  if (!shas.includes(args.featureCommit)) {
    shas.unshift(args.featureCommit);
  }
  const objects: StoreReleaseGitObjectUpload[] = [];
  for (const sha of shas) {
    objects.push(await readCompressedGitObject(args.worktreeRoot, sha));
  }
  return objects;
};

export type StoreReleaseGitArtifactBuild = {
  gitArtifact: StoreReleaseGitArtifact;
  objectUploads: StoreReleaseGitObjectUpload[];
  diff: string;
  commitHashes: string[];
};

export const collectStoreReleaseGitArtifact = async (args: {
  repoRoot: string;
  attachedFeatureNames: string[];
  snapshot: ReturnType<StoreModStore["readFeatureSnapshot"]>;
}): Promise<StoreReleaseGitArtifactBuild | undefined> => {
  const ordered = await collectStoreReleaseCommitHashes(args);
  if (ordered.length === 0) return undefined;
  if (ordered.length > STORE_RELEASE_GIT_ARTIFACT_COMMIT_LIMIT) {
    throw new Error(
      `Store publish supports at most ${STORE_RELEASE_GIT_ARTIFACT_COMMIT_LIMIT} selected commits at once.`,
    );
  }
  const canonicalBase = await resolveStorePublishCanonicalBase({
    repoRoot: args.repoRoot,
    firstSelectedCommit: ordered[0]!,
  });
  // The git fast path uploads only objects reachable from featureCommit but not
  // canonicalBase. Installers on a different desktop release may not have that
  // base commit; they safely fall back to the agent path.

  const tempRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "stella-store-publish-"),
  );
  const worktreeRoot = path.join(tempRoot, "worktree");
  const redact = buildStoreReleaseRedactor();
  try {
    await runStoreReleaseGit(args.repoRoot, ["worktree", "prune"]).catch(
      () => undefined,
    );
    await runStoreReleaseGitOrThrow(args.repoRoot, [
      "worktree",
      "add",
      "--detach",
      worktreeRoot,
      canonicalBase,
    ]);
    for (const hash of ordered) {
      const cherryPick = await runStoreReleaseGit(worktreeRoot, [
        "cherry-pick",
        "--no-commit",
        hash,
      ]);
      if (cherryPick.status !== 0) {
        await runStoreReleaseGit(worktreeRoot, ["cherry-pick", "--abort"]);
        const detail =
          gitStdoutText(cherryPick.stderr).trim() ||
          gitStdoutText(cherryPick.stdout).trim() ||
          `Could not apply ${hash}`;
        throw new Error(
          `Store publish could not squash the selected commits cleanly: ${detail}`,
        );
      }
    }

    const security = await sanitizeStorePublishWorktree({
      worktreeRoot,
      baseCommit: canonicalBase,
      redactor: redact,
    });
    const hasChanges = await runStoreReleaseGit(worktreeRoot, [
      "diff",
      "--cached",
      "--quiet",
    ]);
    if (hasChanges.status === 0) {
      throw new Error(
        "The selected Store feature has no publishable source changes after safety checks.",
      );
    }

    await runStoreReleaseGitOrThrow(worktreeRoot, [
      "-c",
      "user.name=Stella Store",
      "-c",
      "user.email=store@stella.local",
      "commit",
      "-m",
      `Store feature: ${args.attachedFeatureNames.join(", ")}`,
    ]);
    const featureCommit = gitStdoutText(
      await runStoreReleaseGitOrThrow(worktreeRoot, ["rev-parse", "HEAD"]),
    ).trim();
    const diff = redact(
      gitStdoutText(
        await runStoreReleaseGitOrThrow(
          worktreeRoot,
          ["diff", "--find-renames", "--no-color", canonicalBase, featureCommit],
          { maxBuffer: 10 * 1024 * 1024 },
        ),
      ),
    );
    const objectUploads = await listStoreGitArtifactObjects({
      worktreeRoot,
      baseCommit: canonicalBase,
      featureCommit,
    });
    return {
      gitArtifact: {
        kind: "git-object-artifact",
        schemaVersion: 1,
        baseCommit: canonicalBase,
        featureCommit,
        objects: objectUploads.map(({ sha, type, sizeBytes }) => ({
          sha,
          type,
          sizeBytes,
        })),
        security,
      },
      objectUploads,
      diff,
      commitHashes: ordered,
    };
  } finally {
    await runStoreReleaseGit(args.repoRoot, [
      "worktree",
      "remove",
      "--force",
      worktreeRoot,
    ]).catch(() => undefined);
    await fsPromises.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

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
    usernameMatchers.push(new RegExp(`/Users/${escapedUsername}\\b`, "g"));
    usernameMatchers.push(new RegExp(`/home/${escapedUsername}\\b`, "g"));
    usernameMatchers.push(new RegExp(`\\\\Users\\\\${escapedUsername}\\b`, "g"));
  }
  const credentialPatterns: Array<[RegExp, string]> = [
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>"],
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
    for (const matcher of homeMatchers) result = result.replace(matcher, "~");
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
    commits.push({ hash, subject: redact(subject), diff: redact(diff) });
  }
  return commits;
};
