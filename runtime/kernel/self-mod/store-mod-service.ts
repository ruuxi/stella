import type {
  SelfModFeatureRosterPage,
  SelfModFeatureSnapshot,
  StoreInstallRecord,
} from "../../contracts/index.js";
import { StoreModStore } from "../storage/store-mod-store.js";
import { commitGitMessage, getStagedDiffPreview } from "./git/commit.js";
import { getGitCommitParent, listGitDirtyFiles } from "./git/log.js";
import { revertGitCommits } from "./git/revert.js";
import { sanitizeStellaTrailerValue } from "./git/trailers.js";
import { slugify } from "../shared/slug.js";
import { buildStellaSourceChangeSetForGitCommit } from "./stella-source-history.js";
import type {
  StellaSourceRevisionOrigin,
  StellaSourceHistoryStore,
} from "../storage/stella-source-history-store.js";

export type CommitMessageProviderArgs = {
  /** What the agent was asked to do (subagent task description). */
  taskDescription: string;
  /** Files about to be committed (relative repo paths). */
  files: string[];
  /** Truncated unified diff of staged changes (may be empty). */
  diffPreview: string;
  /** Conversation that produced these changes; used as a context hint. */
  conversationId?: string;
};

/**
 * Provider for the agent-authored commit subject. Returning `null` (or
 * an empty string) falls back to the run's task description.
 */
export type CommitMessageProvider = (
  args: CommitMessageProviderArgs,
) => Promise<string | null>;

type SelfModApplyMode =
  | "author"
  | "install"
  | "update"
  | "uninstall"
  | "desktop-update";

type ActiveSelfModRun = {
  generation: number;
  canceled: boolean;
  baselineDirtyFiles: Set<string>;
  taskDescription: string;
  packageId?: string;
  releaseNumber?: number;
  applyMode: SelfModApplyMode;
};

export type FinalizedSelfModCommit = {
  commitHash: string;
  files: string[];
  /**
   * Files left out of the commit: dirty before the run started (user
   * work), or currently owned by another still-active self-mod run
   * (concurrent-run attribution).
   */
  blockedFiles: string[];
  /**
   * Present for store/update apply modes, where the install ledger needs
   * it synchronously. Author-mode runs record source history in the
   * background (off the apply critical path) and omit it here.
   */
  sourceRevisionId?: string;
};

const normalizeFileList = (files: string[]): string[] =>
  Array.from(
    new Set(
      files.map((file) => file.trim().replace(/\\/g, "/")).filter(Boolean),
    ),
  ).sort();

const trimOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeReleaseNumber = (
  value: number | undefined,
): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;

const sanitizeTrailerOrWarn = (
  value: string | undefined,
  trailerName: string,
): string | undefined => {
  const sanitized = sanitizeStellaTrailerValue(value);
  if (value?.trim() && !sanitized) {
    // A dropped trailer silently degrades revert-notice routing to
    // orchestrator-only. Surface it so a new caller with an unexpected
    // key shape fails loudly instead of mysteriously mis-routing undos.
    console.warn(
      `[self-mod] Dropping invalid ${trailerName} trailer value: ${JSON.stringify(value)}`,
    );
  }
  return sanitized;
};

/**
 * Owns the self-mod commit lifecycle and the install ledger. Feature
 * grouping is deterministic and write-time: every author-mode commit is
 * stamped with a `Stella-Feature-Id` trailer (the authoring thread's
 * group key or thread key) and recorded against the durable feature
 * roster; the snapshot the side panel reads is the roster head. No LLM
 * regenerates grouping or names — names freeze at first commit.
 */
export class StoreModService {
  private readonly activeRuns = new Map<string, ActiveSelfModRun>();
  private nextRunGeneration = 0;
  /**
   * Serialized queue for post-commit background work (source-history
   * recording). Chained so revisions record in commit order —
   * parent-revision lookup depends on the previous commit's revision
   * already existing.
   */
  private backgroundQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repoRoot: string,
    private readonly store: StoreModStore,
    private readonly sourceHistory?: StellaSourceHistoryStore,
  ) {
    // One-time import: freeze the pre-roster LLM snapshot's items as
    // legacy features so nothing the user currently sees disappears
    // when the roster takes over.
    try {
      this.store.seedFeatureRosterFromSnapshotIfEmpty();
    } catch (error) {
      console.warn(
        "[self-mod] feature roster seed failed (continuing):",
        (error as Error).message,
      );
    }
  }

  async beginSelfModRun(args: {
    runId: string;
    taskDescription: string;
    packageId?: string;
    releaseNumber?: number;
    applyMode?: SelfModApplyMode;
  }): Promise<void> {
    const taskDescription = args.taskDescription.trim() || "Self mod update";
    const packageId = trimOrUndefined(args.packageId);
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber);
    const baselineDirtyFiles = new Set(await listGitDirtyFiles(this.repoRoot));
    const previousRun = this.activeRuns.get(args.runId);
    if (previousRun) previousRun.canceled = true;
    this.activeRuns.set(args.runId, {
      generation: ++this.nextRunGeneration,
      canceled: false,
      baselineDirtyFiles,
      taskDescription,
      ...(packageId ? { packageId } : {}),
      ...(releaseNumber == null ? {} : { releaseNumber }),
      applyMode: args.applyMode ?? "author",
    });
  }

  cancelSelfModRun(runId: string): void {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) return;
    activeRun.canceled = true;
    if (this.activeRuns.get(runId) === activeRun) {
      this.activeRuns.delete(runId);
    }
  }

  /**
   * Resolves once all queued post-commit background work (source
   * history, feature snapshot) has settled. Call before shutdown and
   * from tests that assert on deferred side effects.
   */
  async waitForBackgroundTasks(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.backgroundQueue;
      await tail;
      // New work may have been queued while awaiting; loop until stable.
    } while (tail !== this.backgroundQueue);
  }

  private enqueueBackgroundTask(task: () => Promise<void>): void {
    this.backgroundQueue = this.backgroundQueue.then(task).catch((error) => {
      console.warn(
        "[self-mod] background post-commit task failed (continuing):",
        (error as Error).message,
      );
    });
  }

  async finalizeSelfModRun(args: {
    runId: string;
    succeeded: boolean;
    /** Conversation that produced these changes; recorded as a commit trailer. */
    conversationId?: string;
    /**
     * Engine thread key of the agent that produced the changes
     * (orchestrator: equals `conversationId`; resumable subagents: the
     * persisted thread/agent id). Recorded as the `Stella-Thread`
     * commit trailer so a future revert can route the "user undid"
     * notice back to the same thread when the orchestrator resumes it.
     */
    threadKey?: string;
    /**
     * Durable feature identity for this work — the authoring thread's
     * group key when grouped, else its thread key. Stamped as the
     * `Stella-Feature-Id` trailer and used as the roster key, so a
     * thread resumed months later keeps extending the same feature.
     */
    featureId?: string;
    /**
     * Human name for the feature (group label or thread description).
     * Slugified into the `Stella-Feature-Title` trailer (trailer values
     * cannot contain spaces); the roster keeps the human form, frozen
     * at the feature's first commit.
     */
    featureTitle?: string;
    /**
     * Concurrent-run attribution guard: returns true when another
     * still-active self-mod run owns `repoRelativePath`. Files owned by
     * a concurrent run are excluded from THIS run's commit (they stay
     * dirty and commit with their own run), so commit trailers never
     * attribute another agent's work to this conversation.
     */
    isPathOwnedByAnotherActiveRun?: (repoRelativePath: string) => boolean;
    commitMessageProvider?: CommitMessageProvider;
  }): Promise<FinalizedSelfModCommit | null> {
    const activeRun = this.activeRuns.get(args.runId);
    if (!activeRun || !args.succeeded) {
      if (activeRun && this.activeRuns.get(args.runId) === activeRun) {
        this.activeRuns.delete(args.runId);
      }
      return null;
    }

    const stillOwnsRun = () => {
      const currentRun = this.activeRuns.get(args.runId);
      return (
        !activeRun.canceled &&
        currentRun === activeRun &&
        currentRun.generation === activeRun.generation
      );
    };

    try {
      const currentDirtyFiles = normalizeFileList(
        await listGitDirtyFiles(this.repoRoot),
      );
      if (currentDirtyFiles.length === 0 || !stillOwnsRun()) {
        return null;
      }

      const baselineDirty = activeRun.baselineDirtyFiles;
      const blockedFiles: string[] = [];
      const safeFiles: string[] = [];
      for (const file of currentDirtyFiles) {
        if (baselineDirty.has(file)) {
          blockedFiles.push(file);
        } else if (args.isPathOwnedByAnotherActiveRun?.(file)) {
          blockedFiles.push(file);
        } else {
          safeFiles.push(file);
        }
      }
      if (safeFiles.length === 0) {
        return null;
      }

      const conversationTrailer = sanitizeTrailerOrWarn(
        args.conversationId,
        "Stella-Conversation",
      );
      const threadTrailer = sanitizeTrailerOrWarn(
        args.threadKey,
        "Stella-Thread",
      );
      const featureIdTrailer = sanitizeTrailerOrWarn(
        args.featureId ?? args.threadKey,
        "Stella-Feature-Id",
      );
      const featureTitle = trimOrUndefined(args.featureTitle);
      // Trailer values cannot contain spaces (STELLA_TRAILER_VALUE_REGEX)
      // and sanitizeTrailerOrWarn would silently drop a human phrase — the
      // slug goes in the commit, the human form goes in the roster.
      const featureTitleTrailer = sanitizeTrailerOrWarn(
        featureTitle ? slugify(featureTitle) : undefined,
        "Stella-Feature-Title",
      );
      const subject =
        activeRun.applyMode === "author"
          ? await this.deriveCommitSubject({
              activeRun,
              safeFiles,
              conversationTrailer,
              commitMessageProvider: args.commitMessageProvider,
            })
          : this.deriveInstallCommitSubject(activeRun);

      const trailers: Record<string, string> = {};
      if (conversationTrailer) {
        trailers["Stella-Conversation"] = conversationTrailer;
      }
      if (threadTrailer) {
        trailers["Stella-Thread"] = threadTrailer;
      }
      if (activeRun.applyMode === "author") {
        if (featureIdTrailer) {
          trailers["Stella-Feature-Id"] = featureIdTrailer;
        }
        if (featureTitleTrailer) {
          trailers["Stella-Feature-Title"] = featureTitleTrailer;
        }
      }
      if (activeRun.applyMode !== "author") {
        if (activeRun.packageId) {
          trailers["Stella-Package-Id"] = activeRun.packageId;
        }
        if (activeRun.releaseNumber != null) {
          trailers["Stella-Release-Number"] = String(activeRun.releaseNumber);
        }
        if (activeRun.taskDescription) {
          trailers["Stella-Task"] = activeRun.taskDescription;
        }
      }

      const commitHash = await commitGitMessage({
        repoRoot: this.repoRoot,
        subject,
        trailers,
        paths: safeFiles,
        shouldCommit: stillOwnsRun,
      });
      if (!commitHash) {
        return null;
      }

      if (activeRun.applyMode === "author") {
        // Durable feature accounting is synchronous and deterministic —
        // no LLM in the loop. The roster freezes the feature's name at
        // its first commit and accrues commits forever; the snapshot the
        // side panel reads is just the roster head, so names never churn
        // and old features never fall off.
        if (featureIdTrailer) {
          try {
            this.store.upsertFeatureRosterEntry({
              featureId: featureIdTrailer,
              name: featureTitle ?? activeRun.taskDescription,
              ...(conversationTrailer
                ? { conversationId: conversationTrailer }
                : {}),
              commitHash,
            });
            this.store.writeFeatureSnapshot(
              this.store.buildSnapshotFromRoster(),
            );
          } catch (error) {
            console.warn(
              "[self-mod] feature roster update failed (continuing):",
              (error as Error).message,
            );
          }
        }
        // Source-history recording stays off the critical path: the
        // worker's apply/morph (or pending "Update" card) only needs the
        // commit hash.
        this.enqueueBackgroundTask(async () => {
          await this.recordSourceRevisionForCommit({
            activeRun,
            commitHash,
            subject,
            conversationTrailer,
            featureId: featureIdTrailer,
          }).catch((error) => {
            console.warn(
              "[self-mod] source history recording failed (continuing):",
              (error as Error).message,
            );
          });
        });
        return {
          commitHash,
          files: safeFiles,
          blockedFiles,
        };
      }

      // Store install/update/uninstall and desktop-update commits need the
      // source revision id synchronously — it lands in the install ledger.
      const sourceRevisionId = await this.recordSourceRevisionForCommit({
        activeRun,
        commitHash,
        subject,
        conversationTrailer,
      }).catch((error) => {
        console.warn(
          "[self-mod] source history recording failed (continuing):",
          (error as Error).message,
        );
        return null;
      });

      return {
        commitHash,
        files: safeFiles,
        blockedFiles,
        ...(sourceRevisionId ? { sourceRevisionId } : {}),
      };
    } finally {
      if (this.activeRuns.get(args.runId) === activeRun) {
        this.activeRuns.delete(args.runId);
      }
    }
  }

  private async recordSourceRevisionForCommit(args: {
    activeRun: ActiveSelfModRun;
    commitHash: string;
    subject: string;
    conversationTrailer: string | undefined;
    /** Trailer feature id; when present it is the canonical identity. */
    featureId?: string;
  }): Promise<string | null> {
    if (!this.sourceHistory) return null;
    const parentCommitHash = await getGitCommitParent(
      this.repoRoot,
      args.commitHash,
    );
    const parentRevision = parentCommitHash
      ? this.sourceHistory.findRevisionByCommit(parentCommitHash)
      : null;
    const featureId = args.activeRun.packageId
      ? `store:${args.activeRun.packageId}`
      : (args.featureId ??
        (args.conversationTrailer
          ? `self-mod:${args.conversationTrailer}`
          : `self-mod:${args.commitHash}`));
    const origin: StellaSourceRevisionOrigin =
      args.activeRun.applyMode === "install"
        ? "store-install"
        : args.activeRun.applyMode === "update"
          ? "store-update"
          : args.activeRun.applyMode === "uninstall"
            ? "store-uninstall"
            : args.activeRun.applyMode === "desktop-update"
              ? "desktop-update"
              : "self-mod";
    const { changeSet } = await buildStellaSourceChangeSetForGitCommit({
      repoRoot: this.repoRoot,
      commitHash: args.commitHash,
      parentRevisionId: parentRevision?.revisionId,
      featureId,
      description: args.subject,
    });
    const record = this.sourceHistory.recordRevision({
      changeSet,
      origin,
      commitHash: args.commitHash,
      ...(args.activeRun.packageId
        ? { packageId: args.activeRun.packageId }
        : {}),
      ...(args.activeRun.releaseNumber != null
        ? { releaseNumber: args.activeRun.releaseNumber }
        : {}),
      featureId,
      description: args.subject,
    });
    return record.revisionId;
  }

  private async deriveCommitSubject(args: {
    activeRun: ActiveSelfModRun;
    safeFiles: string[];
    conversationTrailer: string | undefined;
    commitMessageProvider: CommitMessageProvider | undefined;
  }): Promise<string> {
    const fallback =
      trimOrUndefined(args.activeRun.taskDescription) ?? "Self mod update";
    if (!args.commitMessageProvider) {
      return fallback;
    }
    let diffPreview = "";
    try {
      diffPreview = await getStagedDiffPreview(this.repoRoot, {
        paths: args.safeFiles,
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
      const trimmed = result?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : fallback;
    } catch {
      return fallback;
    }
  }

  private deriveInstallCommitSubject(activeRun: ActiveSelfModRun): string {
    const subjectPrefix =
      activeRun.applyMode === "uninstall"
        ? "Store uninstall"
        : activeRun.applyMode === "update"
          ? "Store update"
          : activeRun.applyMode === "desktop-update"
            ? "Desktop update"
            : "Store install";
    return activeRun.packageId
      ? `${subjectPrefix}: ${activeRun.packageId}`
      : subjectPrefix;
  }

  readFeatureSnapshot(): SelfModFeatureSnapshot | null {
    return this.store.readFeatureSnapshot();
  }

  listFeatureRoster(args?: {
    limit?: number;
    offset?: number;
  }): SelfModFeatureRosterPage {
    const entries = this.store.listFeatureRoster(args).map((entry) => ({
      ...entry,
      commitHashes: this.store.listFeatureCommitHashes(entry.featureId),
    }));
    return { entries, total: this.store.countFeatureRoster() };
  }

  recordInstall(args: {
    packageId: string;
    releaseNumber: number;
    installCommitHash: string | null;
    sourceRevisionId?: string | null;
    sourceRevisionIds?: string[];
  }): StoreInstallRecord {
    return this.store.recordInstall(args);
  }

  getInstall(packageId: string): StoreInstallRecord | null {
    return this.store.getInstall(packageId);
  }

  listInstalls(): StoreInstallRecord[] {
    return this.store.listInstalls();
  }

  async uninstall(packageId: string): Promise<{
    revertedCommits: string[];
    fallbackRequired: boolean;
    reason?: string;
  }> {
    const install = this.store.getInstall(packageId);
    if (!install) {
      return { revertedCommits: [], fallbackRequired: false };
    }
    let revertedCommits: string[] = [];
    const hashes =
      install.installCommitHashes.length > 0
        ? install.installCommitHashes
        : install.installCommitHash
          ? [install.installCommitHash]
          : [];
    if (hashes.length > 0) {
      const dirtyFiles = await listGitDirtyFiles(this.repoRoot);
      if (dirtyFiles.length > 0) {
        return {
          revertedCommits: [],
          fallbackRequired: true,
          reason: "working tree is not clean",
        };
      }
      // Revert the add-on's own commits directly, newest-first. `git revert`
      // computes each inverse patch and applies it at HEAD, so this works even
      // when the add-on is no longer the latest commit (e.g. another add-on was
      // installed after it) — the common case that previously dropped to the
      // slow agent. The tree was just verified clean, so a conflicting revert
      // resets back to the pre-revert HEAD (leaving history untouched), and we
      // hand off to the agent fallback only when the inverse genuinely cannot
      // apply (a later edit overlapped this add-on's lines).
      try {
        revertedCommits = await revertGitCommits({
          repoRoot: this.repoRoot,
          commitHashes: [...hashes].reverse(),
          resetToPreRevertHeadOnFailure: true,
        });
      } catch (error) {
        return {
          revertedCommits: [],
          fallbackRequired: true,
          reason: `add-on changes overlap later edits and could not be reverted cleanly: ${(error as Error).message}`,
        };
      }
    }
    this.store.deleteInstall(packageId);
    return { revertedCommits, fallbackRequired: false };
  }

  forgetInstall(packageId: string): void {
    this.store.deleteInstall(packageId);
  }
}
