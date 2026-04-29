import type {
  InstalledStoreModRecord,
  LocalGitCommitRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StorePublishCandidateBundle,
} from "../../contracts/index.js";
import { StoreModStore } from "../storage/store-mod-store.js";
import {
  assertStellaSelfModCommits,
  commitGitMessage,
  commitGitOperation,
  getCommitReference,
  getCommitSelectionSnapshots,
  getStagedDiffPreview,
  listDependencyFiles,
  listGitCommitsBySelector,
  listGitDirtyFiles,
  listRecentGitCommits,
  orderCommitHashesChronologically,
  stageGitPathsForCommit,
} from "./git.js";

export type CommitMessageProviderArgs = {
  /** What the agent was asked to do (subagent task description). */
  taskDescription: string;
  /** Files about to be committed (relative repo paths). */
  files: string[];
  /** Truncated unified diff of staged changes (may be empty). */
  diffPreview: string;
  /**
   * Conversation that produced these changes. The provider can use this
   * as a default seed when nothing in the roster matches (the LLM gets
   * it as context; nothing else relies on it being set).
   */
  conversationId?: string;
};

/**
 * Result returned by the commit-message LLM. `subject` is the only
 * always-required field; the rest are optional grouping hints written
 * onto the commit as `Stella-*` trailers when present.
 */
export type CommitMessageProviderResult = {
  subject: string;
  featureId?: string;
  featureTitle?: string;
  /** Multi-parent: extending more than one installed add-on is allowed. */
  parentPackageIds?: string[];
};

/**
 * Optional callback invoked by finalizeSelfModRun to produce a human-readable
 * commit message + grouping decision just before committing. The runtime
 * layer passes this in so `StoreModService` stays LLM-agnostic.
 *
 * Returning `null` (or a result with no `subject`) falls back to the
 * task description with no trailers attached.
 */
export type CommitMessageProvider = (
  args: CommitMessageProviderArgs,
) => Promise<CommitMessageProviderResult | string | null>;

type ActiveSelfModRun = {
  baselineDirtyFiles: Set<string>;
  taskDescription: string;
  packageId?: string;
  releaseNumber?: number;
  applyMode: "author" | "install" | "update";
};

export type FinalizedSelfModCommit = {
  commitHash: string;
  files: string[];
  blockedFiles: string[];
  applyMode: "author" | "install" | "update";
  packageId?: string;
  releaseNumber?: number;
};

type FetchReleaseResult = {
  package: StorePackageRecord;
  release: StorePackageReleaseRecord;
  artifact: StoreReleaseArtifact;
};

const normalizeFileList = (files: string[]): string[] =>
  Array.from(new Set(files.map((file) => file.trim().replace(/\\/g, "/")).filter(Boolean))).sort();

const sanitizeConversationTrailer = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9._:\-]{1,200}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
};

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeReleaseNumber = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;

export class StoreModService {
  private readonly activeRuns = new Map<string, ActiveSelfModRun>();

  constructor(
    private readonly repoRoot: string,
    private readonly store: StoreModStore,
  ) {}

  async beginSelfModRun(args: {
    runId: string;
    taskDescription: string;
    packageId?: string;
    releaseNumber?: number;
    applyMode?: "author" | "install" | "update";
  }): Promise<void> {
    const taskDescription = args.taskDescription.trim() || "Self mod update";
    const baselineDirtyFiles = new Set(await listGitDirtyFiles(this.repoRoot));
    this.activeRuns.set(args.runId, {
      baselineDirtyFiles,
      taskDescription,
      ...(trimOrUndefined(args.packageId) ? { packageId: trimOrUndefined(args.packageId) } : {}),
      ...(normalizeReleaseNumber(args.releaseNumber) == null
        ? {}
        : { releaseNumber: normalizeReleaseNumber(args.releaseNumber) }),
      applyMode: args.applyMode ?? "author",
    });
  }

  cancelSelfModRun(runId: string): void {
    this.activeRuns.delete(runId);
  }

  async finalizeSelfModRun(args: {
    runId: string;
    succeeded: boolean;
    /** Conversation that produced these changes; recorded as a commit trailer. */
    conversationId?: string;
    /**
     * Callback invoked by the runtime to produce an agent-authored commit
     * message. Only used for author-mode runs (install/update keep their
     * deterministic "Store install/update <package>" subjects).
     */
    commitMessageProvider?: CommitMessageProvider;
  }): Promise<FinalizedSelfModCommit | null> {
    const activeRun = this.activeRuns.get(args.runId);
    this.activeRuns.delete(args.runId);
    if (!activeRun || !args.succeeded) {
      return null;
    }

    const currentDirtyFiles = normalizeFileList(await listGitDirtyFiles(this.repoRoot));
    if (currentDirtyFiles.length === 0) {
      return null;
    }

    const baselineDirty = activeRun.baselineDirtyFiles;
    const blockedFiles = currentDirtyFiles.filter((file) => baselineDirty.has(file));
    const safeFiles = currentDirtyFiles.filter((file) => !baselineDirty.has(file));

    if (safeFiles.length === 0) {
      return null;
    }

    // Dependency files (package.json, lockfiles, …) follow the agent's
    // changes only when they (a) actually changed during this run and
    // (b) weren't dirty at run begin. Staging them unconditionally would
    // sweep in unrelated user work staged before the agent started.
    const currentDirtySet = new Set(currentDirtyFiles);
    const dependencyFiles = await listDependencyFiles(this.repoRoot);
    const safeDepFiles = dependencyFiles.filter(
      (file) => currentDirtySet.has(file) && !baselineDirty.has(file),
    );
    const commitPaths = normalizeFileList([...safeFiles, ...safeDepFiles]);

    const conversationTrailer = sanitizeConversationTrailer(args.conversationId);
    const commitHash = await this.commitFinalizedRun({
      activeRun,
      safeFiles,
      commitPaths,
      conversationTrailer,
      commitMessageProvider: args.commitMessageProvider,
    });
    if (!commitHash) {
      return null;
    }

    if (
      activeRun.packageId
      && activeRun.releaseNumber != null
      && activeRun.applyMode !== "author"
    ) {
      this.store.recordInstallCommit({
        packageId: activeRun.packageId,
        releaseNumber: activeRun.releaseNumber,
        applyCommitHash: commitHash,
      });
    }
    return {
      commitHash,
      files: safeFiles,
      blockedFiles,
      applyMode: activeRun.applyMode,
      ...(activeRun.packageId ? { packageId: activeRun.packageId } : {}),
      ...(activeRun.releaseNumber == null ? {} : { releaseNumber: activeRun.releaseNumber }),
    };
  }

  private async commitFinalizedRun(args: {
    activeRun: ActiveSelfModRun;
    safeFiles: string[];
    commitPaths: string[];
    conversationTrailer: string | undefined;
    commitMessageProvider: CommitMessageProvider | undefined;
  }): Promise<string | null> {
    const { activeRun } = args;
    await stageGitPathsForCommit(this.repoRoot, args.commitPaths);

    if (activeRun.applyMode === "author") {
      const decision = await this.deriveAuthorCommitDecision({
        activeRun,
        safeFiles: args.safeFiles,
        commitPaths: args.commitPaths,
        commitMessageProvider: args.commitMessageProvider,
        conversationTrailer: args.conversationTrailer,
      });
      const trailers: Record<string, string | string[]> = {};
      if (args.conversationTrailer) {
        trailers["Stella-Conversation"] = args.conversationTrailer;
      }
      if (decision.featureId) {
        trailers["Stella-Feature-Id"] = decision.featureId;
      }
      if (decision.featureTitle) {
        trailers["Stella-Feature-Title"] = decision.featureTitle;
      }
      if (decision.parentPackageIds && decision.parentPackageIds.length > 0) {
        trailers["Stella-Parent-Package-Id"] = decision.parentPackageIds;
      }
      return await commitGitMessage({
        repoRoot: this.repoRoot,
        subject: decision.subject,
        trailers,
        paths: args.commitPaths,
      });
    }

    // Install/update commits keep a deterministic subject + machine-readable
    // trailers so `recordInstallCommit` can later reconcile them with the
    // package they belong to.
    const subjectPrefix =
      activeRun.applyMode === "install" ? "Store install" : "Store update";
    const subject = activeRun.packageId
      ? `${subjectPrefix}: ${activeRun.packageId}`
      : subjectPrefix;
    const bodyLines: string[] = [];
    if (activeRun.packageId) {
      bodyLines.push(`Stella-Package-Id: ${activeRun.packageId}`);
    }
    if (activeRun.releaseNumber != null) {
      bodyLines.push(`Stella-Release-Number: ${activeRun.releaseNumber}`);
    }
    if (activeRun.taskDescription) {
      bodyLines.push(`Stella-Task: ${activeRun.taskDescription}`);
    }
    if (args.conversationTrailer) {
      bodyLines.push(`Stella-Conversation: ${args.conversationTrailer}`);
    }
    return await commitGitOperation({
      repoRoot: this.repoRoot,
      subject,
      bodyLines,
      paths: args.commitPaths,
    });
  }

  private async deriveAuthorCommitDecision(args: {
    activeRun: ActiveSelfModRun;
    safeFiles: string[];
    commitPaths: string[];
    commitMessageProvider: CommitMessageProvider | undefined;
    conversationTrailer: string | undefined;
  }): Promise<CommitMessageProviderResult> {
    const fallbackSubject =
      trimOrUndefined(args.activeRun.taskDescription) ?? "Self mod update";
    if (!args.commitMessageProvider) {
      return { subject: fallbackSubject };
    }
    let diffPreview = "";
    try {
      diffPreview = await getStagedDiffPreview(this.repoRoot, {
        paths: args.commitPaths,
      });
    } catch {
      diffPreview = "";
    }
    try {
      const result = await args.commitMessageProvider({
        taskDescription: args.activeRun.taskDescription,
        files: args.safeFiles,
        diffPreview,
        ...(args.conversationTrailer
          ? { conversationId: args.conversationTrailer }
          : {}),
      });
      if (typeof result === "string") {
        const trimmed = result.trim();
        return {
          subject: trimmed.length > 0 ? trimmed : fallbackSubject,
        };
      }
      if (result && typeof result === "object" && "subject" in result) {
        const trimmedSubject = result.subject?.trim();
        return {
          subject:
            trimmedSubject && trimmedSubject.length > 0
              ? trimmedSubject
              : fallbackSubject,
          ...(result.featureId ? { featureId: result.featureId.trim() } : {}),
          ...(result.featureTitle
            ? { featureTitle: result.featureTitle.trim() }
            : {}),
          ...(result.parentPackageIds && result.parentPackageIds.length > 0
            ? {
                parentPackageIds: Array.from(
                  new Set(
                    result.parentPackageIds
                      .map((entry) => entry.trim())
                      .filter(Boolean),
                  ),
                ),
              }
            : {}),
        };
      }
      return { subject: fallbackSubject };
    } catch {
      return { subject: fallbackSubject };
    }
  }

  /**
   * Flat list of recent self-mod commits for the Store UI. Skips silently
   * when the working tree isn't a Git repo so the renderer can degrade
   * gracefully (e.g. fresh installs or detached worktrees).
   */
  async listLocalCommits(limit?: number): Promise<LocalGitCommitRecord[]> {
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.min(500, Math.floor(limit)))
        : 50;
    try {
      const summaries = await listRecentGitCommits(this.repoRoot, safeLimit);
      return summaries.map((entry) => ({ ...entry } satisfies LocalGitCommitRecord));
    } catch {
      return [];
    }
  }

  /**
   * Targeted commit lookup used by the publish path + the pick-card.
   * Walks the same wide history window the feature roster scans so a
   * feature row that is still rendered (but whose commits are older
   * than the recent-commit slice) can still resolve to its commits.
   */
  async listLocalCommitsBySelector(args: {
    featureIds?: string[];
    commitHashes?: string[];
  }): Promise<LocalGitCommitRecord[]> {
    try {
      const summaries = await listGitCommitsBySelector(this.repoRoot, args);
      return summaries.map((entry) => ({ ...entry } satisfies LocalGitCommitRecord));
    } catch {
      return [];
    }
  }

  async buildPublishCandidateBundle(args: {
    requestText: string;
    selectedCommitHashes: string[];
    existingPackageId?: string;
  }): Promise<StorePublishCandidateBundle> {
    const selectedCommitHashes = Array.from(
      new Set(args.selectedCommitHashes.map((hash) => hash.trim()).filter(Boolean)),
    );
    if (selectedCommitHashes.length === 0) {
      throw new Error("At least one change must be selected to publish.");
    }
    await assertStellaSelfModCommits({
      repoRoot: this.repoRoot,
      commitHashes: selectedCommitHashes,
    });
    const orderedHashes = await orderCommitHashesChronologically({
      repoRoot: this.repoRoot,
      commitHashes: selectedCommitHashes,
    });
    const commits = await Promise.all(
      orderedHashes.map(async (commitHash) => {
        const reference = await getCommitReference({
          repoRoot: this.repoRoot,
          commitHash,
        });
        return {
          ...reference,
          shortHash: commitHash.slice(0, 12),
        };
      }),
    );
    const files = normalizeFileList(commits.flatMap((commit) => commit.files));
    const snapshots = await getCommitSelectionSnapshots({
      repoRoot: this.repoRoot,
      commitHashes: orderedHashes,
      files,
    });
    return {
      requestText: args.requestText,
      selectedCommitHashes: orderedHashes,
      commits,
      files: snapshots,
      ...(trimOrUndefined(args.existingPackageId)
        ? { existingPackageId: trimOrUndefined(args.existingPackageId) }
        : {}),
    };
  }

  getInstalledModByPackageId(packageId: string): InstalledStoreModRecord | null {
    return this.store.getInstalledModByPackageId(packageId);
  }

  listInstalledMods(): InstalledStoreModRecord[] {
    return this.store.listInstalledMods();
  }

  async installRelease(args: {
    packageId: string;
    releaseNumber: number;
    fetchRelease: (args: {
      packageId: string;
      releaseNumber: number;
    }) => Promise<FetchReleaseResult>;
    applyRelease: (args: {
      package: StorePackageRecord;
      release: StorePackageReleaseRecord;
      artifact: StoreReleaseArtifact;
      mode: "install" | "update";
    }) => Promise<void>;
  }): Promise<{ installRecord: InstalledStoreModRecord }> {
    const payload = await args.fetchRelease({
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
    });
    const existingInstall = this.store.getInstalledModByPackageId(payload.package.packageId);
    const mode: "install" | "update" = existingInstall ? "update" : "install";
    await args.applyRelease({
      package: payload.package,
      release: payload.release,
      artifact: payload.artifact,
      mode,
    });
    const installRecord = this.store.getInstalledModByPackageId(payload.package.packageId);
    if (!installRecord) {
      throw new Error("Store install completed without recording a local install commit.");
    }
    return {
      installRecord,
    };
  }

  markInstallUninstalled(installId: string): void {
    this.store.markInstallUninstalled(installId);
  }

}
