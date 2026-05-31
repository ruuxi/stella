import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { setupEnvironment } from "dugite";
import { listGitDirtyFiles } from "../kernel/self-mod/git.js";
import type { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import {
  STORE_SOURCE_DEPENDENCY_FILE_NAMES,
  runStoreSourcePackDependencyInstall,
  storeSourcePackTouchesDependencyFiles,
} from "./store-source-pack-install.js";
import type { SourceImportLifecycle } from "./source-import.js";

const execFileAsync = promisify(execFile);

type GitRunStatus = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const toText = (value: string | Buffer | undefined): string =>
  Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");

const expandExternalSelfModPaths = (paths: string[]): string[] => {
  const expanded = new Set(paths);
  if (storeSourcePackTouchesDependencyFiles(paths)) {
    for (const dependencyFile of STORE_SOURCE_DEPENDENCY_FILE_NAMES) {
      expanded.add(dependencyFile);
    }
  }
  return [...expanded];
};

export const runGitStatus = async (
  cwd: string,
  args: string[],
  options?: { maxBuffer?: number },
): Promise<GitRunStatus> => {
  const { env, gitLocation } = setupEnvironment({});
  try {
    const result = await execFileAsync(gitLocation, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: options?.maxBuffer ?? 20 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout: toText(result.stdout),
      stderr: toText(result.stderr),
    };
  } catch (error) {
    const err = error as {
      code?: unknown;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: toText(err.stdout),
      stderr: toText(err.stderr),
    };
  }
};

export const runGit = async (
  cwd: string,
  args: string[],
  options?: { maxBuffer?: number },
): Promise<string> => {
  const result = await runGitStatus(cwd, args, options);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  const details =
    result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  throw new Error(`Git command failed (${args.join(" ")}): ${details}`);
};

export const getGitTopLevel = async (cwd: string): Promise<string | null> => {
  const result = await runGitStatus(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) return null;
  const topLevel = result.stdout.trim();
  return topLevel ? path.resolve(topLevel) : null;
};

export const resolveGitCommit = async (
  repoRoot: string,
  ref = "HEAD",
): Promise<string> => await runGit(repoRoot, ["rev-parse", `${ref}^{commit}`]);

export const listGitTreeFiles = async (
  repoRoot: string,
  ref = "HEAD",
): Promise<string[]> => {
  const output = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    ref,
  ]);
  return output.split("\0").map((entry) => entry.trim()).filter(Boolean);
};

export const listGitRecentCommitsForImport = async (
  repoRoot: string,
  ref = "HEAD",
  limit = 12,
): Promise<string> => {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  return await runGit(
    repoRoot,
    [
      "log",
      `--max-count=${safeLimit}`,
      "--date=short",
      "--pretty=format:%h %ad %s",
      ref,
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  ).catch(() => "");
};

export const cloneGitSource = async (args: {
  url: string;
  ref?: string;
  destination: string;
}): Promise<{ repoRoot: string; commit: string }> => {
  await fsPromises.rm(args.destination, { recursive: true, force: true });
  await runGit(path.dirname(args.destination), [
    "clone",
    "--no-tags",
    "--no-checkout",
    args.url,
    args.destination,
  ]);
  const checkoutRef = args.ref?.trim() || "HEAD";
  await runGit(args.destination, ["checkout", "--detach", checkoutRef]);
  const commit = await resolveGitCommit(args.destination, "HEAD");
  return { repoRoot: args.destination, commit };
};

export type GitImportReference = {
  repoRoot: string;
  fetchRef: string;
  commit: string;
};

export const fetchGitImportReference = async (args: {
  repoRoot: string;
  source: GitImportReference;
}): Promise<void> => {
  await runGit(args.repoRoot, [
    "fetch",
    "--no-tags",
    args.source.repoRoot,
    args.source.fetchRef,
  ]);
};

export const getGitMergeBase = async (
  repoRoot: string,
  left = "HEAD",
  right = "FETCH_HEAD",
): Promise<string | null> => {
  const result = await runGitStatus(repoRoot, ["merge-base", left, right]);
  if (result.exitCode !== 0) return null;
  const base = result.stdout.trim();
  return base || null;
};

export const buildGitReferenceDiff = async (args: {
  repoRoot: string;
  source: GitImportReference;
  limit?: number;
}): Promise<{ text: string; mergeBase: string | null }> => {
  await fetchGitImportReference(args);
  const mergeBase = await getGitMergeBase(args.repoRoot);
  if (!mergeBase) {
    return {
      mergeBase: null,
      text:
        "No merge base exists between this Stella tree and the source ref, so there is no native git reference diff. Use the source checkout and recent commits instead.",
    };
  }
  const stat = await runGit(
    args.repoRoot,
    ["diff", "--stat", mergeBase, "FETCH_HEAD"],
    { maxBuffer: 2 * 1024 * 1024 },
  ).catch(() => "");
  const patch = await runGit(
    args.repoRoot,
    ["diff", "--find-renames", mergeBase, "FETCH_HEAD"],
    { maxBuffer: args.limit ?? 2 * 1024 * 1024 },
  ).catch((error) => `Could not produce reference diff: ${(error as Error).message}`);
  const text = [stat, patch].filter(Boolean).join("\n\n");
  return {
    mergeBase,
    text: text || "(source ref has no diff from the merge base)",
  };
};

type GitNameStatusChange = {
  status: string;
  path: string;
  deleted: boolean;
};

const parseNameStatus = (raw: string): GitNameStatusChange[] => {
  const fields = raw.split("\0").filter(Boolean);
  const changes: GitNameStatusChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]?.trim();
    const filePath = fields[index + 1]?.trim();
    if (!status || !filePath) continue;
    changes.push({
      status,
      path: filePath.replace(/\\/g, "/"),
      deleted: status === "D",
    });
  }
  return changes;
};

const applyMergedTreeToWorkingTree = async (args: {
  repoRoot: string;
  treeHash: string;
  changes: GitNameStatusChange[];
}): Promise<void> => {
  const deleted = args.changes
    .filter((change) => change.deleted)
    .map((change) => change.path);
  const present = args.changes
    .filter((change) => !change.deleted)
    .map((change) => change.path);

  if (present.length > 0) {
    await runGit(args.repoRoot, ["checkout", args.treeHash, "--", ...present]);
  }

  for (const filePath of deleted) {
    await fsPromises.rm(path.join(args.repoRoot, filePath), {
      recursive: true,
      force: true,
    });
  }
};

export type GitSourceImportFastPathResult =
  | {
      status: "applied";
      commitHash: string;
      appliedPaths: string[];
      dependencyInstallRan: boolean;
    }
  | {
      status: "no-changes";
      reason: string;
    }
  | {
      status: "needs-agent";
      reason: string;
    };

export const tryGitSourceImportFastPath = async (args: {
  repoRoot: string;
  source: GitImportReference;
  service: StoreModService;
  scope: { kind: "all" | "feature"; label?: string };
  trust: "trusted" | "untrusted";
  taskDescription: string;
  conversationId: string;
  lifecycle?: SourceImportLifecycle;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<GitSourceImportFastPathResult> => {
  if (args.scope.kind !== "all") {
    return {
      status: "needs-agent",
      reason:
        "Native git fast path only imports whole refs; named feature extraction needs the agent.",
    };
  }

  const dirtyFiles = await listGitDirtyFiles(args.repoRoot);
  if (dirtyFiles.length > 0) {
    return {
      status: "needs-agent",
      reason: "The import tree has local working-tree changes.",
    };
  }

  await fetchGitImportReference({ repoRoot: args.repoRoot, source: args.source });
  const mergeBase = await getGitMergeBase(args.repoRoot);
  if (!mergeBase) {
    return {
      status: "needs-agent",
      reason:
        "The source ref does not share git history with this Stella tree.",
    };
  }

  const mergeTreeResult = await runGitStatus(
    args.repoRoot,
    ["merge-tree", "--write-tree", "HEAD", "FETCH_HEAD"],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  if (mergeTreeResult.exitCode !== 0) {
    const details =
      mergeTreeResult.stderr.trim() ||
      mergeTreeResult.stdout.trim() ||
      "git merge-tree reported conflicts";
    return {
      status: "needs-agent",
      reason: `Native git merge-tree was not clean: ${details}`,
    };
  }

  const treeHash = mergeTreeResult.stdout.trim().split(/\s+/)[0] ?? "";
  if (!treeHash) {
    return {
      status: "needs-agent",
      reason: "Native git merge-tree did not return a merged tree.",
    };
  }

  const headTree = await runGit(args.repoRoot, ["rev-parse", "HEAD^{tree}"]);
  if (headTree === treeHash) {
    return {
      status: "no-changes",
      reason: "The source ref is already represented in this tree.",
    };
  }

  const rawNameStatus = await runGit(args.repoRoot, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    "HEAD",
    treeHash,
  ]);
  const changes = parseNameStatus(rawNameStatus);
  const appliedPaths = Array.from(new Set(changes.map((change) => change.path)));
  if (appliedPaths.length === 0) {
    return {
      status: "no-changes",
      reason: "The source ref produced no file changes.",
    };
  }

  const runId = `source-import-git:${randomUUID()}`;
  let hmrRunStarted = false;
  await args.service.beginSelfModRun({
    runId,
    taskDescription: args.taskDescription,
    applyMode: "author",
  });
  try {
    if (args.lifecycle?.beginExternalSelfMod) {
      await args.lifecycle.beginExternalSelfMod({
        runId,
        paths: expandExternalSelfModPaths(appliedPaths),
      });
      hmrRunStarted = true;
    }

    await applyMergedTreeToWorkingTree({
      repoRoot: args.repoRoot,
      treeHash,
      changes,
    });

    const dependencyInstallRan =
      storeSourcePackTouchesDependencyFiles(appliedPaths);
    if (dependencyInstallRan) {
      await runStoreSourcePackDependencyInstall(args.repoRoot);
    }

    const finalized = await args.service.finalizeSelfModRun({
      runId,
      succeeded: true,
      conversationId: args.conversationId,
      threadKey: args.conversationId,
    });
    if (!finalized?.commitHash) {
      throw new Error(
        "Native git import wrote changes but did not create an import commit.",
      );
    }

    if (hmrRunStarted && args.lifecycle?.finishExternalSelfMod) {
      await args.lifecycle.finishExternalSelfMod({ runId, succeeded: true });
      hmrRunStarted = false;
    }

    args.log?.("source-import.git-fast.applied", {
      commitHash: finalized.commitHash,
      appliedPathCount: appliedPaths.length,
    });
    return {
      status: "applied",
      commitHash: finalized.commitHash,
      appliedPaths,
      dependencyInstallRan,
    };
  } catch (error) {
    args.service.cancelSelfModRun(runId);
    if (hmrRunStarted && args.lifecycle?.finishExternalSelfMod) {
      await args.lifecycle
        .finishExternalSelfMod({ runId, succeeded: false })
        .catch(() => undefined);
    }
    throw error;
  }
};
