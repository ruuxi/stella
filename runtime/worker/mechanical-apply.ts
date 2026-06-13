/**
 * Shared "mechanical apply" ladder for non-agent install paths.
 *
 * Both git-backed fast paths (Store git-artifact installs and launcher
 * source imports) and the source-pack fast path converge on the same
 * shape: try a clean mechanical application of the change, otherwise
 * report `needs-agent` with a reason and let the caller fall back to a
 * general-agent run. This module owns the pieces they used to
 * duplicate — the merge-tree eligibility check, working-tree
 * materialization, dependency-file expansion, and the
 * begin/apply/finalize self-mod lifecycle envelope.
 */
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { StoreModService } from "../kernel/self-mod/store-mod-service.js";
import {
  STORE_PUBLISH_DEPENDENCY_FILE_NAMES,
  runStorePublishDependencyInstall,
  storePublishTouchesDependencyFiles,
} from "./store-source-pack-install.js";
import type { SourceImportLifecycle } from "./source-import.js";
import { runGit, runGitStatus } from "./git-exec.js";

export type GitNameStatusChange = {
  status: string;
  path: string;
  deleted: boolean;
};

export const parseNameStatus = (raw: string): GitNameStatusChange[] => {
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

/**
 * Paths an install must never read, write, or delete. A malformed Store
 * artifact that touches these (e.g. a published `node_modules` symlink from
 * an authoring worktree, or anything under `.git/`) would corrupt the user's
 * checkout — refuse the install before any filesystem op instead of letting
 * the damage land. The fast-path caller catches the throw and falls back to
 * the agent path, where a parallel rule in the install prompt keeps the
 * agent from re-applying the same paths.
 */
const FORBIDDEN_PATH_PREFIXES = ["node_modules/", ".git/"] as const;
const isForbiddenInstallPath = (path: string): boolean => {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return FORBIDDEN_PATH_PREFIXES.some(
    (prefix) =>
      normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
};

export const applyMergedTreeToWorkingTree = async (args: {
  repoRoot: string;
  treeHash: string;
  changes: GitNameStatusChange[];
}): Promise<void> => {
  const forbidden = args.changes
    .map((change) => change.path)
    .filter(isForbiddenInstallPath);
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to apply Store install: artifact touches forbidden paths (${forbidden.slice(0, 3).join(", ")}${forbidden.length > 3 ? ", …" : ""}). Installs may not change node_modules or .git.`,
    );
  }

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

/**
 * Dependency manifests follow the change for HMR pinning: when an apply
 * touches package.json/lockfiles, the runtime must also own the sibling
 * lock/manifest files for the duration of the run.
 */
export const expandExternalSelfModPaths = (paths: string[]): string[] => {
  const expanded = new Set(paths);
  if (storePublishTouchesDependencyFiles(paths)) {
    for (const dependencyFile of STORE_PUBLISH_DEPENDENCY_FILE_NAMES) {
      expanded.add(dependencyFile);
    }
  }
  return [...expanded];
};

export type MergeTreeOutcome =
  | {
      status: "merged";
      treeHash: string;
      changes: GitNameStatusChange[];
      changedPaths: string[];
    }
  | { status: "no-changes"; reason: string }
  | { status: "needs-agent"; reason: string };

/**
 * Run `git merge-tree --write-tree HEAD <mergeRef>` and classify the
 * outcome: a clean merged tree with its name-status changes, a no-op
 * (ref already represented), or `needs-agent` with the conflict detail.
 */
export const computeCleanMergeTree = async (args: {
  repoRoot: string;
  mergeRef: string;
}): Promise<MergeTreeOutcome> => {
  const mergeTreeResult = await runGitStatus(
    args.repoRoot,
    ["merge-tree", "--write-tree", "HEAD", args.mergeRef],
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
  const changedPaths = Array.from(new Set(changes.map((change) => change.path)));
  if (changedPaths.length === 0) {
    return {
      status: "no-changes",
      reason: "The source ref produced no file changes.",
    };
  }
  return { status: "merged", treeHash, changes, changedPaths };
};

export type MechanicalApplyEnvelopeResult = {
  commitHash: string;
  sourceRevisionId?: string;
  dependencyInstallRan: boolean;
};

/**
 * The begin → pin paths → apply → (dependency install) → finalize →
 * finish envelope every mechanical apply shares. On any failure the
 * self-mod run is cancelled and the external HMR run (if started) is
 * finished unsuccessfully before the error rethrows.
 */
export const runMechanicalApplyWithLifecycle = async (args: {
  runId: string;
  conversationId: string;
  repoRoot: string;
  service: StoreModService;
  begin: {
    taskDescription: string;
    packageId?: string;
    releaseNumber?: number;
    applyMode: "author" | "install" | "update";
  };
  /** Repo-relative paths the apply will touch (pre-dependency-expansion). */
  changedPaths: string[];
  lifecycle?: SourceImportLifecycle;
  /** Performs the working-tree mutation. */
  apply: () => Promise<void>;
  /**
   * Run `bun install` after apply when dependency manifests were
   * touched. Set false when `apply` already handles installs itself.
   */
  installDependencies?: boolean;
  /** Error thrown when finalize produced no commit. */
  noCommitError: string;
}): Promise<MechanicalApplyEnvelopeResult> => {
  let hmrRunStarted = false;
  await args.service.beginSelfModRun({
    runId: args.runId,
    taskDescription: args.begin.taskDescription,
    ...(args.begin.packageId ? { packageId: args.begin.packageId } : {}),
    ...(args.begin.releaseNumber != null
      ? { releaseNumber: args.begin.releaseNumber }
      : {}),
    applyMode: args.begin.applyMode,
  });
  try {
    if (args.lifecycle?.beginExternalSelfMod) {
      await args.lifecycle.beginExternalSelfMod({
        runId: args.runId,
        paths: expandExternalSelfModPaths(args.changedPaths),
      });
      hmrRunStarted = true;
    }

    await args.apply();

    const dependencyInstallRan =
      args.installDependencies !== false &&
      storePublishTouchesDependencyFiles(args.changedPaths);
    if (dependencyInstallRan) {
      await runStorePublishDependencyInstall(args.repoRoot);
    }

    const finalized = await args.service.finalizeSelfModRun({
      runId: args.runId,
      succeeded: true,
      conversationId: args.conversationId,
      threadKey: args.conversationId,
    });
    if (!finalized?.commitHash) {
      throw new Error(args.noCommitError);
    }

    if (hmrRunStarted && args.lifecycle?.finishExternalSelfMod) {
      await args.lifecycle.finishExternalSelfMod({
        runId: args.runId,
        succeeded: true,
      });
      hmrRunStarted = false;
    }

    return {
      commitHash: finalized.commitHash,
      ...(finalized.sourceRevisionId
        ? { sourceRevisionId: finalized.sourceRevisionId }
        : {}),
      dependencyInstallRan,
    };
  } catch (error) {
    args.service.cancelSelfModRun(args.runId);
    if (hmrRunStarted && args.lifecycle?.finishExternalSelfMod) {
      await args.lifecycle
        .finishExternalSelfMod({ runId: args.runId, succeeded: false })
        .catch(() => undefined);
    }
    throw error;
  }
};
