import type {
  SelfModFeatureRosterPage,
  SelfModFeatureSnapshot,
  StoreInstallRecord,
} from "../../contracts/index.js";
import { StoreModStore } from "../storage/store-mod-store.js";
import {
  commitGitMessage,
  getStagedDiffPreview,
  readGitHeadFileState,
  type ExactGitFileState,
} from "./git/commit.js";
import { getGitCommitParent, listGitDirtyFiles } from "./git/log.js";
import { revertGitCommits } from "./git/revert.js";
import { sanitizeStellaTrailerValue } from "./git/trailers.js";
import { slugify } from "../shared/slug.js";
import { buildStellaSourceChangeSetForGitCommit } from "./stella-source-history.js";
import type {
  StellaSourceRevisionOrigin,
  StellaSourceHistoryStore,
} from "../storage/stella-source-history-store.js";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  LogicalSelfModChangeSetStore,
  readWorkingTreeFileState,
  type FrozenLogicalChangeSet,
  type LogicalFileState,
  type LogicalFileConflict,
  type MediatedWriteCapture,
} from "./logical-change-set.js";
import { acquireSelfModMutationLock } from "./mutation-lock.js";

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
  baselineDirtyFiles: Set<string>;
  taskDescription: string;
  packageId?: string;
  releaseNumber?: number;
  applyMode: SelfModApplyMode;
};

type PreparedAuthorChange = {
  activeRun: ActiveSelfModRun;
  subject: string;
  trailers: Record<string, string>;
  conversationTrailer?: string;
  featureIdTrailer?: string;
  featureTitle?: string;
};

type PersistedPreparedAuthorChange = {
  changeSet: FrozenLogicalChangeSet;
  prepared: Omit<PreparedAuthorChange, "activeRun"> & {
    activeRun: Omit<ActiveSelfModRun, "baselineDirtyFiles"> & {
      baselineDirtyFiles: string[];
    };
  };
  envelope?: unknown;
};

export const PENDING_CHANGE_SET_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_PENDING_CHANGE_SETS = 64;

export type StartupDiscardCandidate = {
  changeSetId: string;
  runId: string;
  files: string[];
  envelope?: unknown;
};

export type ApplyPreparedAuthorResult =
  | {
      status: "applied";
      commitHash: string | null;
      files: ExactGitFileState[];
      selectedFiles: ExactGitFileState[];
      noopPaths: string[];
    }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

export type MaterializeLiveTreeResult =
  | { status: "applied" }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

export type AtomicDiscardPreparedAuthorResult =
  | { status: "discarded"; discarded: boolean }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

export type StartupDiscardCleanupResult =
  | {
      status: "applied";
      completedChangeSetIds: string[];
      retryChangeSetIds: string[];
    }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

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
  private readonly logicalChanges: LogicalSelfModChangeSetStore;
  private readonly preparedAuthorChanges = new Map<
    string,
    PreparedAuthorChange
  >();
  private readonly pendingEnvelopes = new Map<string, unknown>();
  private readonly startupDiscardCandidates = new Map<
    string,
    StartupDiscardCandidate
  >();
  /** Serializes apply, discard, reconstruction, and retention cleanup. */
  private authorMutationTail: Promise<void> = Promise.resolve();
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
    this.logicalChanges = new LogicalSelfModChangeSetStore(repoRoot);
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
    this.restorePreparedAuthorChanges();
  }

  private restorePreparedAuthorChanges(): void {
    const validRows: Array<{
      row: ReturnType<StoreModStore["listPendingSelfModChangeSets"]>[number];
      persisted: PersistedPreparedAuthorChange;
      createdAt: number;
    }> = [];
    for (const row of this.store.listPendingSelfModChangeSets(this.repoRoot)) {
      const persisted = row.payload as PersistedPreparedAuthorChange;
      if (
        !persisted ||
        typeof persisted !== "object" ||
        !persisted.changeSet ||
        !persisted.prepared?.activeRun
      ) {
        this.store.deletePendingSelfModChangeSet(row.changeSetId);
        continue;
      }
      validRows.push({
        row,
        persisted,
        createdAt: Number.isFinite(persisted.changeSet.createdAt)
          ? persisted.changeSet.createdAt
          : row.createdAt,
      });
    }

    const cutoff = Date.now() - PENDING_CHANGE_SET_TTL_MS;
    const freshRows = validRows.filter((entry) => entry.createdAt >= cutoff);
    const retainedIds = new Set(
      freshRows
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_PENDING_CHANGE_SETS)
        .map((entry) => entry.row.changeSetId),
    );

    for (const { row, persisted } of validRows) {
      if (!retainedIds.has(row.changeSetId)) {
        this.startupDiscardCandidates.set(row.changeSetId, {
          changeSetId: row.changeSetId,
          runId: persisted.changeSet.runId,
          files: persisted.changeSet.files.map((file) => file.path),
          ...(persisted.envelope !== undefined
            ? { envelope: persisted.envelope }
            : {}),
        });
        continue;
      }
      const activeRun = persisted.prepared.activeRun;
      this.logicalChanges.restore(persisted.changeSet);
      this.preparedAuthorChanges.set(row.changeSetId, {
        ...persisted.prepared,
        activeRun: {
          ...activeRun,
          baselineDirtyFiles: new Set(activeRun.baselineDirtyFiles ?? []),
        },
      });
      if (persisted.envelope !== undefined) {
        this.pendingEnvelopes.set(row.changeSetId, persisted.envelope);
      }
    }
  }

  listStartupDiscardCandidates(): StartupDiscardCandidate[] {
    return [...this.startupDiscardCandidates.values()];
  }

  private completeStartupDiscardCandidates(
    changeSetIds: Iterable<string>,
  ): void {
    for (const changeSetId of changeSetIds) {
      this.startupDiscardCandidates.delete(changeSetId);
      this.store.deletePendingSelfModChangeSet(changeSetId);
    }
  }

  private persistPreparedAuthorChange(changeSetId: string): void {
    const changeSet = this.logicalChanges.get(changeSetId);
    const prepared = this.preparedAuthorChanges.get(changeSetId);
    if (!changeSet || !prepared) return;
    this.store.upsertPendingSelfModChangeSet({
      changeSetId,
      repoRoot: this.repoRoot,
      createdAt: changeSet.createdAt,
      payload: {
        changeSet,
        prepared: {
          ...prepared,
          activeRun: {
            ...prepared.activeRun,
            baselineDirtyFiles: [...prepared.activeRun.baselineDirtyFiles],
          },
        },
        ...(this.pendingEnvelopes.has(changeSetId)
          ? { envelope: this.pendingEnvelopes.get(changeSetId) }
          : {}),
      } satisfies PersistedPreparedAuthorChange,
    });
  }

  persistPendingEnvelope(changeSetId: string, envelope: unknown): void {
    if (!this.preparedAuthorChanges.has(changeSetId)) return;
    this.pendingEnvelopes.set(changeSetId, envelope);
    this.persistPreparedAuthorChange(changeSetId);
  }

  listPendingEnvelopes(): unknown[] {
    return this.logicalChanges.listPending().map((changeSet) => {
      const envelope = this.pendingEnvelopes.get(changeSet.changeSetId);
      if (envelope !== undefined) return envelope;
      const prepared = this.preparedAuthorChanges.get(changeSet.changeSetId);
      return {
        commitHash: changeSet.changeSetId,
        changeSetId: changeSet.changeSetId,
        runId: changeSet.runId,
        conversationId: prepared?.conversationTrailer ?? "",
        files: changeSet.files.map((file) => file.path),
      };
    });
  }

  listPendingChangeSetIds(): string[] {
    return this.logicalChanges
      .listPending()
      .map((changeSet) => changeSet.changeSetId);
  }

  listExpiredPendingChangeSetIds(now = Date.now()): string[] {
    const cutoff = now - PENDING_CHANGE_SET_TTL_MS;
    return this.logicalChanges
      .listPending()
      .filter((changeSet) => changeSet.createdAt < cutoff)
      .map((changeSet) => changeSet.changeSetId);
  }

  getPreparedLogicalChangeSet(
    changeSetId: string,
  ): FrozenLogicalChangeSet | null {
    return this.logicalChanges.get(changeSetId);
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
    this.activeRuns.set(args.runId, {
      baselineDirtyFiles,
      taskDescription,
      ...(packageId ? { packageId } : {}),
      ...(releaseNumber == null ? {} : { releaseNumber }),
      applyMode: args.applyMode ?? "author",
    });
    if ((args.applyMode ?? "author") === "author") {
      this.logicalChanges.beginRun(args.runId);
    }
  }

  async beginMediatedWrite(
    runId: string,
    absolutePaths: Iterable<string>,
    options?: { captureAll?: boolean },
  ): Promise<MediatedWriteCapture | null> {
    return await this.logicalChanges.beginWrite(runId, absolutePaths, options);
  }

  async finishMediatedWrite(
    capture: MediatedWriteCapture | null,
    additionalAbsolutePaths?: Iterable<string>,
  ): Promise<void> {
    await this.logicalChanges.finishWrite(capture, additionalAbsolutePaths);
  }

  async changedPathsForCapture(
    capture: MediatedWriteCapture | null,
  ): Promise<string[]> {
    return await this.logicalChanges.changedPathsForCapture(capture);
  }

  cancelSelfModRun(runId: string): void {
    this.activeRuns.delete(runId);
    this.logicalChanges.cancelRun(runId);
  }

  private discardPreparedAuthorChange(changeSetId: string): boolean {
    const hadPrepared = this.preparedAuthorChanges.delete(changeSetId);
    const discarded = this.logicalChanges.discard(changeSetId);
    this.pendingEnvelopes.delete(changeSetId);
    this.store.deletePendingSelfModChangeSet(changeSetId);
    return hadPrepared || discarded !== null;
  }

  private async withAuthorMutationTransaction<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.authorMutationTail;
    let releaseQueue!: () => void;
    this.authorMutationTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    let releaseMutation: (() => void) | undefined;
    try {
      releaseMutation = await acquireSelfModMutationLock(
        this.repoRoot,
        `${label}:${crypto.randomUUID()}`,
      );
      return await operation();
    } finally {
      releaseMutation?.();
      releaseQueue();
    }
  }

  /**
   * Reconstruct the shared working tree after a selected commit changes HEAD.
   * HEAD is the applied layer; every still-pending or active logical delta is
   * replayed above it. The repo-global mutation lock prevents tools from
   * observing or writing through a partially reconstructed tree.
   */
  async materializeLiveTree(
    paths: Iterable<string>,
    options?: { excludeChangeSetIds?: Iterable<string> },
  ): Promise<MaterializeLiveTreeResult> {
    return await this.withAuthorMutationTransaction("materialize", async () =>
      this.materializeLiveTreeLocked(paths, options),
    );
  }

  private async materializeLiveTreeLocked(
    paths: Iterable<string>,
    options?: { excludeChangeSetIds?: Iterable<string> },
  ): Promise<MaterializeLiveTreeResult> {
    const plan = await this.logicalChanges.buildLiveTree(
      paths,
      (filePath) => readGitHeadFileState(this.repoRoot, filePath),
      options,
    );
    if (plan.status === "conflicts") return plan;

    const originals = new Map<string, LogicalFileState>();
    for (const filePath of plan.states.keys()) {
      originals.set(
        filePath,
        await readWorkingTreeFileState(path.join(this.repoRoot, filePath)),
      );
    }
    try {
      for (const [filePath, state] of plan.states) {
        await this.writeWorkingTreeState(filePath, state);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const [filePath, state] of originals) {
        await this.writeWorkingTreeState(filePath, state).catch(
          (rollbackError) => rollbackErrors.push(rollbackError),
        );
      }
      if (rollbackErrors.length > 0) {
        console.error(
          "[self-mod] live-tree reconstruction rollback failed:",
          rollbackErrors,
        );
      }
      throw error;
    }
    return { status: "applied" };
  }

  async discardPreparedAuthorChangeAtomically(
    changeSetId: string,
    paths: Iterable<string>,
  ): Promise<AtomicDiscardPreparedAuthorResult> {
    return await this.withAuthorMutationTransaction(
      `discard:${changeSetId}`,
      async () => {
        if (
          !this.preparedAuthorChanges.has(changeSetId) &&
          !this.logicalChanges.get(changeSetId)
        ) {
          return { status: "discarded", discarded: false };
        }
        const reconstruction = await this.materializeLiveTreeLocked(paths, {
          excludeChangeSetIds: [changeSetId],
        });
        if (reconstruction.status === "conflicts") return reconstruction;
        return {
          status: "discarded",
          discarded: this.discardPreparedAuthorChange(changeSetId),
        };
      },
    );
  }

  async cleanupStartupDiscardCandidatesAtomically(
    candidates: StartupDiscardCandidate[],
    cleanupExternalState: (
      candidate: StartupDiscardCandidate,
    ) => Promise<boolean>,
  ): Promise<StartupDiscardCleanupResult> {
    return await this.withAuthorMutationTransaction(
      "startup-retention-cleanup",
      async () => {
        const reconstruction = await this.materializeLiveTreeLocked(
          candidates.flatMap((candidate) => candidate.files),
        );
        if (reconstruction.status === "conflicts") return reconstruction;

        const completedChangeSetIds: string[] = [];
        const retryChangeSetIds: string[] = [];
        for (const candidate of candidates) {
          let completed = false;
          try {
            completed = await cleanupExternalState(candidate);
          } catch (error) {
            console.warn(
              `[self-mod] Startup cleanup failed for ${candidate.changeSetId}:`,
              (error as Error).message,
            );
          }
          if (!completed) {
            retryChangeSetIds.push(candidate.changeSetId);
            continue;
          }
          this.completeStartupDiscardCandidates([candidate.changeSetId]);
          completedChangeSetIds.push(candidate.changeSetId);
        }
        return {
          status: "applied",
          completedChangeSetIds,
          retryChangeSetIds,
        };
      },
    );
  }

  private async writeWorkingTreeState(
    repoRelativePath: string,
    state: LogicalFileState,
  ): Promise<void> {
    const destination = path.join(this.repoRoot, repoRelativePath);
    if (state.kind === "missing") {
      await fs.rm(destination, { force: true, recursive: true });
      return;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.stella-selfmod-${crypto.randomUUID()}`;
    try {
      if (state.kind === "symlink") {
        await fs.symlink(
          Buffer.from(state.contentBase64, "base64").toString("utf8"),
          temporary,
        );
      } else {
        await fs.writeFile(
          temporary,
          Buffer.from(state.contentBase64, "base64"),
          { mode: state.mode === "100755" ? 0o755 : 0o644 },
        );
        await fs.chmod(temporary, state.mode === "100755" ? 0o755 : 0o644);
      }
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true, recursive: true }).catch(() => {});
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
    this.activeRuns.delete(args.runId);
    if (!activeRun || !args.succeeded) {
      this.logicalChanges.cancelRun(args.runId);
      return null;
    }

    if (activeRun.applyMode === "author") {
      const changeSet = this.logicalChanges.finalizeRun(args.runId);
      if (!changeSet) {
        // Backward-compatible direct service callers (older engines and
        // focused tests) do not bracket writes. Keep the historical
        // single-run path for them; production mediated author writes always
        // produce a logical change set and never enter this fallback.
        return await this.finalizeLegacyAuthorRun(activeRun, args);
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
      const featureTitleTrailer = sanitizeTrailerOrWarn(
        featureTitle ? slugify(featureTitle) : undefined,
        "Stella-Feature-Title",
      );
      const files = changeSet.files.map((file) => file.path);
      const subject = await this.deriveCommitSubject({
        activeRun,
        safeFiles: files,
        conversationTrailer,
        commitMessageProvider: args.commitMessageProvider,
      });
      const trailers: Record<string, string> = {};
      if (conversationTrailer)
        trailers["Stella-Conversation"] = conversationTrailer;
      if (threadTrailer) trailers["Stella-Thread"] = threadTrailer;
      if (featureIdTrailer) trailers["Stella-Feature-Id"] = featureIdTrailer;
      if (featureTitleTrailer)
        trailers["Stella-Feature-Title"] = featureTitleTrailer;
      this.preparedAuthorChanges.set(changeSet.changeSetId, {
        activeRun,
        subject,
        trailers,
        ...(conversationTrailer ? { conversationTrailer } : {}),
        ...(featureIdTrailer ? { featureIdTrailer } : {}),
        ...(featureTitle ? { featureTitle } : {}),
      });
      this.persistPreparedAuthorChange(changeSet.changeSetId);
      return {
        // Pending cards historically call this field commitHash. It is an
        // opaque logical selector until apply creates the real commit.
        commitHash: changeSet.changeSetId,
        files,
        blockedFiles: [],
      };
    }

    const currentDirtyFiles = normalizeFileList(
      await listGitDirtyFiles(this.repoRoot),
    );
    if (currentDirtyFiles.length === 0) {
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
    const subject = this.deriveInstallCommitSubject(activeRun);

    const trailers: Record<string, string> = {};
    if (conversationTrailer) {
      trailers["Stella-Conversation"] = conversationTrailer;
    }
    if (threadTrailer) {
      trailers["Stella-Thread"] = threadTrailer;
    }
    if (activeRun.packageId) {
      trailers["Stella-Package-Id"] = activeRun.packageId;
    }
    if (activeRun.releaseNumber != null) {
      trailers["Stella-Release-Number"] = String(activeRun.releaseNumber);
    }
    if (activeRun.taskDescription) {
      trailers["Stella-Task"] = activeRun.taskDescription;
    }

    const commitHash = await commitGitMessage({
      repoRoot: this.repoRoot,
      subject,
      trailers,
      paths: safeFiles,
    });
    if (!commitHash) {
      return null;
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
  }

  async applyPreparedAuthorChange(
    changeSetId: string,
  ): Promise<ApplyPreparedAuthorResult | null> {
    return await this.withAuthorMutationTransaction(
      `apply:${changeSetId}`,
      async () => this.applyPreparedAuthorChangeSerialized(changeSetId),
    );
  }

  private async applyPreparedAuthorChangeSerialized(
    changeSetId: string,
  ): Promise<ApplyPreparedAuthorResult | null> {
    const prepared = this.preparedAuthorChanges.get(changeSetId);
    if (!prepared) return null;
    const mergeBox: {
      value: Awaited<
        ReturnType<LogicalSelfModChangeSetStore["mergeAgainst"]>
      > | null;
    } = { value: null };
    const commitHash = await commitGitMessage({
      repoRoot: this.repoRoot,
      subject: prepared.subject,
      trailers: prepared.trailers,
      files: async () => {
        const result = await this.logicalChanges.mergeAgainst(
          changeSetId,
          (filePath) => readGitHeadFileState(this.repoRoot, filePath),
        );
        mergeBox.value = result;
        return result.status === "clean"
          ? result.files.map((file) => ({ path: file.path, state: file.state }))
          : [];
      },
    });
    const merged = mergeBox.value;
    if (!merged) return null;
    if (merged.status === "conflicts") return merged;
    const files = merged.files.map((file) => ({
      path: file.path,
      state: file.state,
    }));
    const selectedFiles = merged.selectedFiles.map((file) => ({
      path: file.path,
      state: file.state,
    }));
    if (commitHash) {
      if (prepared.featureIdTrailer) {
        try {
          this.store.upsertFeatureRosterEntry({
            featureId: prepared.featureIdTrailer,
            name: prepared.featureTitle ?? prepared.activeRun.taskDescription,
            ...(prepared.conversationTrailer
              ? { conversationId: prepared.conversationTrailer }
              : {}),
            commitHash,
          });
          this.store.writeFeatureSnapshot(this.store.buildSnapshotFromRoster());
        } catch (error) {
          console.warn(
            "[self-mod] feature roster update failed (continuing):",
            (error as Error).message,
          );
        }
      }
      this.enqueueBackgroundTask(async () => {
        await this.recordSourceRevisionForCommit({
          activeRun: prepared.activeRun,
          commitHash,
          subject: prepared.subject,
          conversationTrailer: prepared.conversationTrailer,
          featureId: prepared.featureIdTrailer,
        }).catch((error) => {
          console.warn(
            "[self-mod] source history recording failed (continuing):",
            (error as Error).message,
          );
        });
      });
    }
    this.preparedAuthorChanges.delete(changeSetId);
    this.pendingEnvelopes.delete(changeSetId);
    this.store.deletePendingSelfModChangeSet(changeSetId);
    this.logicalChanges.markApplied(changeSetId);
    return {
      status: "applied",
      commitHash,
      files,
      selectedFiles,
      noopPaths: merged.noopPaths,
    };
  }

  private async finalizeLegacyAuthorRun(
    activeRun: ActiveSelfModRun,
    args: {
      conversationId?: string;
      threadKey?: string;
      featureId?: string;
      featureTitle?: string;
      isPathOwnedByAnotherActiveRun?: (repoRelativePath: string) => boolean;
      commitMessageProvider?: CommitMessageProvider;
    },
  ): Promise<FinalizedSelfModCommit | null> {
    const currentDirtyFiles = normalizeFileList(
      await listGitDirtyFiles(this.repoRoot),
    );
    const blockedFiles: string[] = [];
    const safeFiles: string[] = [];
    for (const file of currentDirtyFiles) {
      if (
        activeRun.baselineDirtyFiles.has(file) ||
        args.isPathOwnedByAnotherActiveRun?.(file)
      ) {
        blockedFiles.push(file);
      } else {
        safeFiles.push(file);
      }
    }
    if (safeFiles.length === 0) return null;
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
    const featureTitleTrailer = sanitizeTrailerOrWarn(
      featureTitle ? slugify(featureTitle) : undefined,
      "Stella-Feature-Title",
    );
    const subject = await this.deriveCommitSubject({
      activeRun,
      safeFiles,
      conversationTrailer,
      commitMessageProvider: args.commitMessageProvider,
    });
    const trailers: Record<string, string> = {};
    if (conversationTrailer)
      trailers["Stella-Conversation"] = conversationTrailer;
    if (threadTrailer) trailers["Stella-Thread"] = threadTrailer;
    if (featureIdTrailer) trailers["Stella-Feature-Id"] = featureIdTrailer;
    if (featureTitleTrailer)
      trailers["Stella-Feature-Title"] = featureTitleTrailer;
    const commitHash = await commitGitMessage({
      repoRoot: this.repoRoot,
      subject,
      trailers,
      paths: safeFiles,
    });
    if (!commitHash) return null;
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
        this.store.writeFeatureSnapshot(this.store.buildSnapshotFromRoster());
      } catch (error) {
        console.warn(
          "[self-mod] feature roster update failed (continuing):",
          (error as Error).message,
        );
      }
    }
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
    return { commitHash, files: safeFiles, blockedFiles };
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
