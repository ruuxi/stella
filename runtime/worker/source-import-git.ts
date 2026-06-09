import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { listGitDirtyFiles } from "../kernel/self-mod/git/log.js";
import type { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import { runGit, runGitStatus } from "./git-exec.js";
import {
  applyMergedTreeToWorkingTree,
  computeCleanMergeTree,
  runMechanicalApplyWithLifecycle,
} from "./mechanical-apply.js";
import type { SourceImportLifecycle } from "./source-import.js";

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

  const merge = await computeCleanMergeTree({
    repoRoot: args.repoRoot,
    mergeRef: "FETCH_HEAD",
  });
  if (merge.status !== "merged") {
    return merge;
  }

  const result = await runMechanicalApplyWithLifecycle({
    runId: `source-import-git:${randomUUID()}`,
    conversationId: args.conversationId,
    repoRoot: args.repoRoot,
    service: args.service,
    begin: {
      taskDescription: args.taskDescription,
      applyMode: "author",
    },
    changedPaths: merge.changedPaths,
    lifecycle: args.lifecycle,
    apply: () =>
      applyMergedTreeToWorkingTree({
        repoRoot: args.repoRoot,
        treeHash: merge.treeHash,
        changes: merge.changes,
      }),
    noCommitError:
      "Native git import wrote changes but did not create an import commit.",
  });

  args.log?.("source-import.git-fast.applied", {
    commitHash: result.commitHash,
    appliedPathCount: merge.changedPaths.length,
  });
  return {
    status: "applied",
    commitHash: result.commitHash,
    appliedPaths: merge.changedPaths,
    dependencyInstallRan: result.dependencyInstallRan,
  };
};
