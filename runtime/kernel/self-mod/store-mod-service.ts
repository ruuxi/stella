import type {
  InstalledStoreModRecord,
  LocalGitCommitRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseBlueprintBatch,
  StoreReleaseBlueprintFile,
  StoreReleaseManifest,
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
};

/**
 * Optional callback invoked by finalizeSelfModRun to produce a human-readable
 * commit message just before committing. The runtime layer passes this in so
 * `StoreModService` stays LLM-agnostic.
 */
export type CommitMessageProvider = (
  args: CommitMessageProviderArgs,
) => Promise<string | null>;

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

type PublishReleaseArgs = {
  packageId: string;
  releaseNumber: number;
  displayName: string;
  description: string;
  releaseNotes?: string;
  manifest: StoreReleaseManifest;
  artifact: StoreReleaseArtifact;
};

type PublishReleaseResult = StorePackageReleaseRecord;

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

const DEFAULT_BLUEPRINT_APPLY_GUIDANCE =
  "Treat this release blueprint as the reference implementation for the feature. " +
  "Stella installations can differ, so adapt the changes to the current local codebase instead of blindly copying text. " +
  "Create missing files when the blueprint expects them, update existing files to preserve the intended behavior, " +
  "and delete files only when the blueprint clearly marks them as removed.";

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeReleaseNumber = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;

const buildBlueprintFileChangeType = (args: {
  filePath: string;
  deleted: boolean;
  batches: StoreReleaseBlueprintBatch[];
}): StoreReleaseBlueprintFile["changeType"] => {
  if (args.deleted) {
    return "delete";
  }
  const normalizedPath = args.filePath.replace(/\\/g, "/");
  for (const batch of args.batches) {
    const normalizedPatch = batch.patch.replace(/\r\n/g, "\n");
    if (
      normalizedPatch.includes(`diff --git a/${normalizedPath} b/${normalizedPath}`)
      && (
        normalizedPatch.includes("new file mode")
        || normalizedPatch.includes(`--- /dev/null\n+++ b/${normalizedPath}`)
      )
    ) {
      return "create";
    }
  }
  return "update";
};

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
      const subject = await this.deriveAuthorCommitSubject({
        activeRun,
        safeFiles: args.safeFiles,
        commitPaths: args.commitPaths,
        commitMessageProvider: args.commitMessageProvider,
      });
      const trailers: Record<string, string> = {};
      if (args.conversationTrailer) {
        trailers["Stella-Conversation"] = args.conversationTrailer;
      }
      return await commitGitMessage({
        repoRoot: this.repoRoot,
        subject,
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

  private async deriveAuthorCommitSubject(args: {
    activeRun: ActiveSelfModRun;
    safeFiles: string[];
    commitPaths: string[];
    commitMessageProvider: CommitMessageProvider | undefined;
  }): Promise<string> {
    const fallbackSubject =
      trimOrUndefined(args.activeRun.taskDescription) ?? "Self mod update";
    if (!args.commitMessageProvider) {
      return fallbackSubject;
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
      const message = await args.commitMessageProvider({
        taskDescription: args.activeRun.taskDescription,
        files: args.safeFiles,
        diffPreview,
      });
      const trimmed = message?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : fallbackSubject;
    } catch {
      return fallbackSubject;
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

  getInstalledModByPackageId(packageId: string): InstalledStoreModRecord | null {
    return this.store.getInstalledModByPackageId(packageId);
  }

  listInstalledMods(): InstalledStoreModRecord[] {
    return this.store.listInstalledMods();
  }

  /**
   * Commit-based publish path used by the Store agent.
   *
   * The agent picks raw commit hashes from `git log` and we build the
   * artifact straight from them — no SQL feature/batch state needed.
   */
  async publishCommitsAsRelease(args: {
    commitHashes: string[];
    packageId: string;
    releaseNumber: number;
    displayName: string;
    description: string;
    releaseNotes?: string;
    publish: (args: PublishReleaseArgs) => Promise<PublishReleaseResult>;
  }): Promise<PublishReleaseResult> {
    const packageId = args.packageId.trim();
    if (!packageId) {
      throw new Error("packageId is required.");
    }
    const displayName = args.displayName.trim();
    const description = args.description.trim();
    if (!displayName || !description) {
      throw new Error("displayName and description are required.");
    }
    const commitHashes = Array.from(
      new Set(args.commitHashes.map((hash) => hash.trim()).filter(Boolean)),
    );
    if (commitHashes.length === 0) {
      throw new Error("At least one commit must be selected to publish.");
    }
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber) ?? 1;

    const artifact = await this.buildReleaseArtifactFromCommits({
      packageId,
      releaseNumber,
      displayName,
      description,
      releaseNotes: args.releaseNotes?.trim(),
      commitHashes,
    });

    return await args.publish({
      packageId,
      releaseNumber,
      displayName,
      description,
      releaseNotes: args.releaseNotes?.trim(),
      manifest: artifact.manifest,
      artifact,
    });
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

  /**
   * Build a release blueprint from raw commit hashes (no SQL feature state).
   */
  private async buildReleaseArtifactFromCommits(args: {
    packageId: string;
    releaseNumber: number;
    displayName: string;
    description: string;
    releaseNotes?: string;
    commitHashes: string[];
  }): Promise<StoreReleaseArtifact> {
    // Refuse to publish anything that isn't a Stella self-mod commit
    // (current `Stella-*` trailer scheme or legacy `[feature:…]` tag).
    // Throws with the offending hashes so the Store agent surfaces a
    // clear error rather than producing a silently-tainted release.
    await assertStellaSelfModCommits({
      repoRoot: this.repoRoot,
      commitHashes: args.commitHashes,
    });
    const orderedHashes = await orderCommitHashesChronologically({
      repoRoot: this.repoRoot,
      commitHashes: args.commitHashes,
    });
    const batchReferences: StoreReleaseBlueprintBatch[] = await Promise.all(
      orderedHashes.map(async (commitHash, index) => {
        const reference = await getCommitReference({
          repoRoot: this.repoRoot,
          commitHash,
        });
        return {
          batchId: `commit:${commitHash.slice(0, 12)}`,
          ordinal: index + 1,
          commitHash,
          files: [...reference.files],
          subject: reference.subject,
          body: reference.body,
          patch: reference.patch,
        } satisfies StoreReleaseBlueprintBatch;
      }),
    );

    const files = normalizeFileList(
      batchReferences.flatMap((batch) => batch.files),
    );
    const snapshots = await getCommitSelectionSnapshots({
      repoRoot: this.repoRoot,
      commitHashes: orderedHashes,
      files,
    });

    const manifest: StoreReleaseManifest = {
      packageId: args.packageId,
      releaseNumber: args.releaseNumber,
      displayName: args.displayName,
      description: args.description,
      ...(args.releaseNotes ? { releaseNotes: args.releaseNotes } : {}),
      batchIds: batchReferences.map((batch) => batch.batchId),
      commitHashes: orderedHashes,
      files,
      createdAt: Date.now(),
    };

    return {
      kind: "self_mod_blueprint",
      schemaVersion: 1,
      manifest,
      applyGuidance: DEFAULT_BLUEPRINT_APPLY_GUIDANCE,
      batches: batchReferences,
      files: snapshots.map((snapshot) => ({
        path: snapshot.path,
        changeType: buildBlueprintFileChangeType({
          filePath: snapshot.path,
          deleted: snapshot.deleted,
          batches: batchReferences,
        }),
        ...(snapshot.deleted ? { deleted: true } : {}),
        ...(snapshot.contentBase64 ? { referenceContentBase64: snapshot.contentBase64 } : {}),
      })),
    };
  }
}
