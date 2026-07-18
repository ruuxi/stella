import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Restart-with-continuation: auto-resume of orchestrator/agent work after a
 * Stella self-restart (self-mod apply, dev relaunch, or any graceful quit).
 *
 * Two cooperating artifacts, both living in `stellaDataDir`:
 *
 *  1. SHUTDOWN RECORD (`restart-continuation.json`) — written by the HOST at
 *     restart initiation (worker restart, host stop / app quit). Minimal on
 *     purpose: `{ episodeId, reason, createdAt }`. The set of interrupted
 *     threads is NOT recorded here — the durable `runtime_agents` rows with
 *     status `running` at next boot are exactly the threads that were in
 *     flight at shutdown. Repeated writes within one restart episode keep
 *     the earliest (most specific) reason AND the episode id but refresh the
 *     timestamp, so staleness is measured from the actual shutdown moment.
 *     The random episode id is the identity that binds every downstream
 *     artifact to this specific restart.
 *
 *  2. INTERRUPTION STATE (`restart-interruption.json`) — written by the
 *     WORKER at boot when it consumes a fresh shutdown record AND threads
 *     were running at shutdown. Conversion is write-then-delete: the state
 *     is durably written BEFORE the record (and snapshot sidecar) are
 *     removed, and a crash between the two is deduped on the next boot via
 *     the same-episode check (matching `episodeId`), so existing delivery
 *     bookkeeping is never reset — while a DISTINCT new episode always
 *     converts, even if timestamps collide.
 *
 *  2b. SNAPSHOT SIDECAR (`restart-interrupted-threads.json`) — written by
 *     the `LocalAgentManager` orphan sweep BEFORE it flips the `running`
 *     rows, stamped with the episode id of the shutdown record present at
 *     that moment. The flip destroys the only live evidence of what was
 *     running, so if the interruption-state write fails on boot 1, this
 *     sidecar is what lets boot 2 genuinely reconstruct the interruption
 *     from the retained shutdown record (the live snapshot is empty by
 *     then). It is accepted as fallback evidence ONLY when its episode id
 *     matches the record's — a mismatched sidecar (e.g. retained from a
 *     failed episode N while the app kept running into a later episode
 *     N+1) is stale and is deleted instead of resurrecting old threads.
 *     Conversion consumes it on every exit path except a failed state
 *     write; the idle rule only applies when BOTH the live snapshot and
 *     the (episode-matched) sidecar are empty.
 *
 * Delivery bookkeeping is PER CONVERSATION with explicit claimed-vs-completed
 * outcomes:
 *
 *  - The boot-time synthetic turn claims a conversation (`turnClaimedAt`)
 *    immediately before dispatching its automation turn, then records
 *    `turnCompletedAt` only on a successful result (`turnFailedAt`
 *    otherwise). A claim without completion — error, hang, crash — leaves
 *    the next-user-message reminder as the PRIMARY recovery path with full
 *    resume guidance; only a completed turn earns the brief
 *    "already resumed" variant.
 *  - The reminder is delivery-safe: attaching marks it pending
 *    (`reminderAttachedAt` + the carrying run id) and it is only consumed
 *    (`reminderConsumedAt`) when that run finishes successfully
 *    (`resolveRestartReminderOutcome`). A failed/interrupted carrying turn
 *    clears the pending mark so the reminder re-attaches on the next user
 *    message.
 *
 * All file writes are atomic (tmp + fsync + rename). Persistence failures
 * fail toward re-attach/re-delivery, never toward silent loss.
 *
 * Guards: env gating, a staleness window on the shutdown record (a stale
 * record produces neither a turn nor a reminder), a 24h GC on the
 * interruption state, and the strict "idle at shutdown → nothing at all"
 * rule (no running rows at boot → no state file).
 *
 * SCOPE: graceful shutdowns only. A SIGKILL / hard crash never writes the
 * shutdown record, so no continuation fires — by design, the record is the
 * authorization that distinguishes a deliberate restart from a crash. (The
 * pre-existing orphan sweep still tidies thread rows after a crash.)
 *
 * This module must stay import-light (node:fs/path only): the host process
 * imports the record-writing half and must not pull the kernel agent stack.
 */

export const RESTART_CONTINUATION_RECORD_FILE = "restart-continuation.json";
export const RESTART_INTERRUPTION_STATE_FILE = "restart-interruption.json";
export const RESTART_INTERRUPTED_SNAPSHOT_FILE =
  "restart-interrupted-threads.json";

/** Shutdown records older than this at boot are discarded unread. */
export const RESTART_CONTINUATION_MAX_RECORD_AGE_MS = 15 * 60_000;
/** Interruption state older than this (since boot) is garbage-collected. */
export const RESTART_INTERRUPTION_STATE_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * Two shutdown-record writes within this window belong to the same restart
 * episode: the earliest reason wins (it is the most specific — e.g. the
 * self-mod apply that requested the restart), but the timestamp refreshes.
 * Beyond the window the old record is a leftover from an episode that never
 * booted (or a much older shutdown) and is replaced wholesale.
 */
export const RESTART_EPISODE_WINDOW_MS = 2 * 60_000;

/** Master switch: disables record writing, the boot turn, and the reminder. */
export const RESTART_CONTINUATION_DISABLE_ENV =
  "STELLA_DISABLE_RESTART_CONTINUATION";
/**
 * Turn-only switch: disables just the boot-time synthetic orchestrator turn.
 * The next-user-message reminder still fires and becomes the primary
 * recovery path.
 */
export const RESTART_CONTINUATION_TURN_DISABLE_ENV =
  "STELLA_DISABLE_RESTART_CONTINUATION_TURN";

export const RESTART_CONTINUATION_REMINDER_CUSTOM_TYPE =
  "runtime.restart_continuation_reminder";
export const RESTART_CONTINUATION_CHAT_SOURCE = "restart-continuation";

type EnvLike = Record<string, string | undefined>;

const isEnvFlagSet = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
};

export const isRestartContinuationEnabled = (env: EnvLike): boolean =>
  !isEnvFlagSet(env[RESTART_CONTINUATION_DISABLE_ENV]);

export const isRestartContinuationTurnEnabled = (env: EnvLike): boolean =>
  isRestartContinuationEnabled(env) &&
  !isEnvFlagSet(env[RESTART_CONTINUATION_TURN_DISABLE_ENV]);

export type RestartShutdownRecord = {
  version: 1;
  /**
   * Random identity of this restart episode. Shared by the snapshot sidecar
   * and the interruption state so fallback evidence and dedupe checks bind
   * to THIS restart, never to leftovers from an earlier one.
   */
  episodeId: string;
  /** e.g. "self-mod-apply-process-restart", "runtime-reload", "app-shutdown". */
  reason: string;
  createdAt: number;
};

export type RestartInterruptedThreadRef = {
  threadId: string;
  conversationId: string;
};

/** Per-conversation delivery bookkeeping. All timestamps ms-epoch. */
export type RestartConversationContinuation = {
  /** Synthetic turn dispatch was claimed (set immediately before dispatch). */
  turnClaimedAt?: number;
  /** The automation turn returned a successful result. */
  turnCompletedAt?: number;
  /** The automation turn errored/threw. Reminder stays full guidance. */
  turnFailedAt?: number;
  /** Reminder is riding an in-flight user turn (pending consumption). */
  reminderAttachedAt?: number;
  /** Run id of the turn the pending reminder rode on, when known. */
  reminderPendingRunId?: string;
  /** Reminder delivered on a turn that completed successfully. Terminal. */
  reminderConsumedAt?: number;
};

export type RestartInterruptionState = {
  version: 2;
  /** Episode id of the shutdown record this state was converted from. */
  episodeId: string;
  reason: string;
  shutdownAt: number;
  bootAt: number;
  /** Threads whose durable rows were `running` at boot (= running at shutdown). */
  threads: RestartInterruptedThreadRef[];
  conversations: Record<string, RestartConversationContinuation>;
};

/**
 * Minimal structural view of a persisted agent row. Structural on purpose:
 * this module must not import the SQLite-backed session store.
 */
export type RestartThreadRecordLike = {
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  status: "running" | "completed" | "error" | "canceled";
  result?: string;
  error?: string;
  updatedAt: number;
};

const recordPath = (stellaDataDir: string) =>
  path.join(stellaDataDir, RESTART_CONTINUATION_RECORD_FILE);

const statePath = (stellaDataDir: string) =>
  path.join(stellaDataDir, RESTART_INTERRUPTION_STATE_FILE);

const snapshotPath = (stellaDataDir: string) =>
  path.join(stellaDataDir, RESTART_INTERRUPTED_SNAPSHOT_FILE);

const readJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    // Missing, unreadable, or malformed/partial JSON — callers treat all of
    // these as "no usable artifact". Atomic writes below make a torn file a
    // legacy/OS-crash artifact rather than a normal failure mode.
    return null;
  }
};

const deleteFileSilently = (filePath: string) => {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort: a leftover file is re-guarded by staleness checks.
  }
};

/**
 * Atomic durable JSON write: tmp file + fsync + rename. A crash mid-write
 * leaves only a stray tmp file, never a torn target. (Directory fsync is
 * skipped deliberately — an entry lost to an OS crash degrades to the
 * documented crash behavior: no continuation.)
 */
const writeJsonAtomic = (filePath: string, value: unknown): void => {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    deleteFileSilently(tmpPath);
    throw error;
  }
};

const parseShutdownRecord = (value: unknown): RestartShutdownRecord | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<RestartShutdownRecord>;
  if (record.version !== 1) return null;
  if (typeof record.reason !== "string" || !record.reason.trim()) return null;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    return null;
  }
  if (typeof record.episodeId !== "string" || !record.episodeId.trim()) {
    return null;
  }
  return {
    version: 1,
    episodeId: record.episodeId,
    reason: record.reason,
    createdAt: record.createdAt,
  };
};

/** Raw record write (atomic). Prefer {@link recordRestartShutdown}. */
export const writeRestartShutdownRecord = (
  stellaDataDir: string,
  args: { reason: string; now?: number; episodeId?: string },
): boolean => {
  try {
    const record: RestartShutdownRecord = {
      version: 1,
      episodeId: args.episodeId ?? crypto.randomUUID(),
      reason: args.reason.trim() || "restart",
      createdAt: args.now ?? Date.now(),
    };
    writeJsonAtomic(recordPath(stellaDataDir), record);
    return true;
  } catch {
    return false;
  }
};

/**
 * Episode-aware shutdown-record write used by every restart-initiation call
 * site. An existing record from the SAME restart episode (age within
 * {@link RESTART_EPISODE_WINDOW_MS}) keeps its earlier, more specific reason
 * AND its episode id but gets a refreshed timestamp — so staleness at next
 * boot is computed from the actual shutdown moment, and a leftover record
 * from an aborted older episode can neither mislabel a newer restart nor
 * kill it via a stale `createdAt`. Beyond the window a fresh episode id is
 * minted, which invalidates any sidecar retained from the older episode.
 */
export const recordRestartShutdown = (
  stellaDataDir: string,
  args: { reason: string; now?: number },
): boolean => {
  const now = args.now ?? Date.now();
  let reason = args.reason;
  let episodeId: string | undefined;
  try {
    const existing = parseShutdownRecord(
      readJsonFile(recordPath(stellaDataDir)),
    );
    if (existing && now - existing.createdAt <= RESTART_EPISODE_WINDOW_MS) {
      reason = existing.reason;
      episodeId = existing.episodeId;
    }
  } catch {
    // Unreadable existing record: fall through with the new reason.
  }
  return writeRestartShutdownRecord(stellaDataDir, {
    reason,
    now,
    ...(episodeId ? { episodeId } : {}),
  });
};

/** Read the shutdown record without deleting it. */
export const peekRestartShutdownRecord = (
  stellaDataDir: string,
): RestartShutdownRecord | null =>
  parseShutdownRecord(readJsonFile(recordPath(stellaDataDir)));

/** Delete the shutdown record (after the interruption state is durable). */
export const deleteRestartShutdownRecord = (stellaDataDir: string): void => {
  deleteFileSilently(recordPath(stellaDataDir));
};

type RestartInterruptedSnapshot = {
  version: 1;
  /** Episode id of the shutdown record present when the sweep captured. */
  episodeId: string;
  capturedAt: number;
  threads: RestartInterruptedThreadRef[];
};

const parseThreadRefs = (value: unknown): RestartInterruptedThreadRef[] =>
  Array.isArray(value)
    ? value.filter(
        (thread): thread is RestartInterruptedThreadRef =>
          Boolean(
            thread &&
              typeof (thread as RestartInterruptedThreadRef).threadId ===
                "string" &&
              typeof (thread as RestartInterruptedThreadRef).conversationId ===
                "string",
          ),
      )
    : [];

/**
 * Durably persist the pre-flip snapshot of running thread rows. Called by
 * the orphan sweep BEFORE any row is flipped: the flip destroys the only
 * live evidence of what was running, and this sidecar is what makes a
 * next-boot retry of a failed interruption-state write real instead of
 * illusory. The sidecar is stamped with the episode id of the shutdown
 * record on disk at capture time — without a record there is no episode the
 * evidence could ever be matched against, so nothing is written. Never
 * called with an empty list (an idle boot must not clobber a sidecar
 * retained for retry). Best-effort: on failure the feature degrades to
 * requiring a successful state write on the same boot.
 */
export const writeRestartInterruptedSnapshot = (
  stellaDataDir: string,
  threads: RestartInterruptedThreadRef[],
  now = Date.now(),
): boolean => {
  if (threads.length === 0) return false;
  const record = peekRestartShutdownRecord(stellaDataDir);
  if (!record) return false;
  try {
    const snapshot: RestartInterruptedSnapshot = {
      version: 1,
      episodeId: record.episodeId,
      capturedAt: now,
      threads: threads.map(({ threadId, conversationId }) => ({
        threadId,
        conversationId,
      })),
    };
    writeJsonAtomic(snapshotPath(stellaDataDir), snapshot);
    return true;
  } catch {
    return false;
  }
};

/** Read the pre-flip snapshot sidecar (tolerant; null when absent/torn). */
export const readRestartInterruptedSnapshot = (
  stellaDataDir: string,
): { episodeId: string; threads: RestartInterruptedThreadRef[] } | null => {
  const value = readJsonFile(snapshotPath(stellaDataDir));
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<RestartInterruptedSnapshot>;
  if (snapshot.version !== 1) return null;
  if (typeof snapshot.episodeId !== "string" || !snapshot.episodeId.trim()) {
    return null;
  }
  return {
    episodeId: snapshot.episodeId,
    threads: parseThreadRefs(snapshot.threads),
  };
};

export const deleteRestartInterruptedSnapshot = (
  stellaDataDir: string,
): void => {
  deleteFileSilently(snapshotPath(stellaDataDir));
};

const parseConversationContinuation = (
  value: unknown,
): RestartConversationContinuation => {
  if (!value || typeof value !== "object") return {};
  const conv = value as Partial<RestartConversationContinuation>;
  const takeNumber = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : undefined;
  return {
    ...(takeNumber(conv.turnClaimedAt) !== undefined
      ? { turnClaimedAt: takeNumber(conv.turnClaimedAt) }
      : {}),
    ...(takeNumber(conv.turnCompletedAt) !== undefined
      ? { turnCompletedAt: takeNumber(conv.turnCompletedAt) }
      : {}),
    ...(takeNumber(conv.turnFailedAt) !== undefined
      ? { turnFailedAt: takeNumber(conv.turnFailedAt) }
      : {}),
    ...(takeNumber(conv.reminderAttachedAt) !== undefined
      ? { reminderAttachedAt: takeNumber(conv.reminderAttachedAt) }
      : {}),
    ...(typeof conv.reminderPendingRunId === "string"
      ? { reminderPendingRunId: conv.reminderPendingRunId }
      : {}),
    ...(takeNumber(conv.reminderConsumedAt) !== undefined
      ? { reminderConsumedAt: takeNumber(conv.reminderConsumedAt) }
      : {}),
  };
};

const parseInterruptionState = (
  value: unknown,
): RestartInterruptionState | null => {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<RestartInterruptionState>;
  if (state.version !== 2) return null;
  if (typeof state.episodeId !== "string" || !state.episodeId.trim()) {
    return null;
  }
  if (typeof state.reason !== "string") return null;
  if (typeof state.shutdownAt !== "number" || typeof state.bootAt !== "number") {
    return null;
  }
  if (!Array.isArray(state.threads)) return null;
  const threads = state.threads.filter(
    (thread): thread is RestartInterruptedThreadRef =>
      Boolean(
        thread &&
          typeof thread.threadId === "string" &&
          typeof thread.conversationId === "string",
      ),
  );
  const conversations: Record<string, RestartConversationContinuation> = {};
  if (state.conversations && typeof state.conversations === "object") {
    for (const [conversationId, conv] of Object.entries(state.conversations)) {
      conversations[conversationId] = parseConversationContinuation(conv);
    }
  }
  return {
    version: 2,
    episodeId: state.episodeId,
    reason: state.reason,
    shutdownAt: state.shutdownAt,
    bootAt: state.bootAt,
    threads,
    conversations,
  };
};

/**
 * Boot-time conversion. Order matters for crash safety:
 *
 *   1. peek (do NOT delete) the shutdown record;
 *   2. durably write the interruption state;
 *   3. delete the record and the snapshot sidecar.
 *
 * The interrupted-thread evidence is the live pre-flip snapshot when this
 * boot's sweep captured one, falling back to the durable snapshot sidecar a
 * PREVIOUS boot's sweep persisted before flipping the rows — accepted ONLY
 * when its episode id matches the record's. That fallback is what makes the
 * failed-state-write retry real: boot 1 flips the rows, so a boot-2 retry
 * can only reconstruct the interruption from the sidecar. A mismatched
 * sidecar is stale leftovers from an older episode and is deleted instead
 * of resurrecting old threads.
 *
 * A crash between 2 and 3 leaves record + sidecar + state; the next boot
 * recognizes the already-converted episode via the same-`episodeId` check
 * and cleans up without resetting the state's delivery bookkeeping.
 *
 * Returns the state when created, null otherwise (no record / stale record /
 * disabled / already converted / idle-at-shutdown). Idle shutdowns are
 * strict: no interrupted threads in EITHER the live snapshot or the sidecar
 * → no state file → no turn AND no reminder. A pre-existing state file from
 * an earlier interruption is only replaced when a NEW interruption is being
 * recorded (newest episode wins), never on null paths.
 */
export const convertRestartShutdownRecordAtBoot = (args: {
  stellaDataDir: string;
  env: EnvLike;
  interruptedThreads: RestartInterruptedThreadRef[];
  now?: number;
}): RestartInterruptionState | null => {
  const now = args.now ?? Date.now();
  const cleanup = () => {
    deleteRestartShutdownRecord(args.stellaDataDir);
    deleteRestartInterruptedSnapshot(args.stellaDataDir);
  };
  if (!isRestartContinuationEnabled(args.env)) {
    // Feature off: drop the artifacts so they can't fire stale on re-enable.
    cleanup();
    return null;
  }
  const record = peekRestartShutdownRecord(args.stellaDataDir);
  if (!record) {
    // Also clears an unparsable/torn record file and an orphaned sidecar
    // (e.g. left by a crash that never wrote a record).
    cleanup();
    return null;
  }
  if (now - record.createdAt > RESTART_CONTINUATION_MAX_RECORD_AGE_MS) {
    cleanup();
    return null;
  }
  const existing = readRestartInterruptionState(args.stellaDataDir, now);
  if (existing && existing.episodeId === record.episodeId) {
    // This episode already converted (a previous boot crashed between the
    // state write and the cleanup). Never rewrite — that would reset the
    // existing delivery bookkeeping. Keyed on the random episode id, so a
    // DISTINCT new record that happens to share a timestamp still converts.
    cleanup();
    return null;
  }
  let interruptedThreads = args.interruptedThreads;
  if (interruptedThreads.length === 0) {
    // Fallback evidence: the pre-flip sidecar — but ONLY when it belongs to
    // THIS record's episode. A mismatched sidecar is a leftover from an
    // older failed episode (the app kept running into a newer restart) and
    // resurrecting its threads would fire a continuation for arbitrarily
    // old work; `cleanup()` below deletes it as stale.
    const sidecar = readRestartInterruptedSnapshot(args.stellaDataDir);
    if (sidecar && sidecar.episodeId === record.episodeId) {
      interruptedThreads = sidecar.threads;
    }
  }
  if (interruptedThreads.length === 0) {
    cleanup();
    return null;
  }
  const state: RestartInterruptionState = {
    version: 2,
    episodeId: record.episodeId,
    reason: record.reason,
    shutdownAt: record.createdAt,
    bootAt: now,
    threads: interruptedThreads.map(({ threadId, conversationId }) => ({
      threadId,
      conversationId,
    })),
    conversations: {},
  };
  try {
    // Durable BEFORE the record/sidecar are removed (write-then-delete).
    writeJsonAtomic(statePath(args.stellaDataDir), state);
  } catch {
    // State could not be persisted: keep the shutdown record AND the
    // snapshot sidecar so the next boot genuinely retries the conversion
    // (its live snapshot will be empty — the rows are already flipped).
    return null;
  }
  cleanup();
  return state;
};

/** Read the interruption state; GC and return null when it aged out. */
export const readRestartInterruptionState = (
  stellaDataDir: string,
  now = Date.now(),
): RestartInterruptionState | null => {
  const filePath = statePath(stellaDataDir);
  if (!fs.existsSync(filePath)) return null;
  const state = parseInterruptionState(readJsonFile(filePath));
  if (!state || now - state.bootAt > RESTART_INTERRUPTION_STATE_MAX_AGE_MS) {
    // Unparsable (torn legacy write) or aged-out state is unrecoverable —
    // delete so it cannot flap. Tolerated, never thrown.
    deleteFileSilently(filePath);
    return null;
  }
  return state;
};

/**
 * Persist a state mutation. Returns false on failure; callers decide the
 * failure direction explicitly (always toward re-delivery, never loss).
 */
const persistInterruptionState = (
  stellaDataDir: string,
  state: RestartInterruptionState,
): boolean => {
  try {
    writeJsonAtomic(statePath(stellaDataDir), state);
    return true;
  } catch {
    return false;
  }
};

const stateConversationIds = (state: RestartInterruptionState): string[] => [
  ...new Set(state.threads.map((thread) => thread.conversationId)),
];

const maybeFinishInterruption = (
  stellaDataDir: string,
  state: RestartInterruptionState,
): void => {
  const done = stateConversationIds(state).every(
    (conversationId) => state.conversations[conversationId]?.reminderConsumedAt,
  );
  if (done) {
    deleteFileSilently(statePath(stellaDataDir));
  } else {
    persistInterruptionState(stellaDataDir, state);
  }
};

/**
 * Attach the reminder to a user turn for `conversationId`. Marks the
 * reminder PENDING (not consumed): consumption only happens via
 * {@link resolveRestartReminderOutcome} when the carrying turn completes
 * successfully. Re-attaches on every user turn until then. Persistence
 * failures still attach (fail toward re-attach, never loss).
 *
 * Returns the interruption facts plus whether the boot-time synthetic turn
 * COMPLETED for this conversation (drives the brief-vs-full variant); null
 * when there is nothing to remind about.
 */
export const attachRestartReminderForConversation = (
  stellaDataDir: string,
  args: { conversationId: string; runId?: string; now?: number },
): {
  state: RestartInterruptionState;
  threads: RestartInterruptedThreadRef[];
  turnCompleted: boolean;
} | null => {
  const now = args.now ?? Date.now();
  const state = readRestartInterruptionState(stellaDataDir, now);
  if (!state) return null;
  const conv = state.conversations[args.conversationId] ?? {};
  if (conv.reminderConsumedAt) return null;
  const threads = state.threads.filter(
    (thread) => thread.conversationId === args.conversationId,
  );
  if (threads.length === 0) return null;
  state.conversations[args.conversationId] = {
    ...conv,
    reminderAttachedAt: now,
    ...(args.runId
      ? { reminderPendingRunId: args.runId }
      : { reminderPendingRunId: undefined }),
  };
  // Best-effort persist: on failure the pending mark is lost and the
  // reminder simply attaches again on the next user turn.
  persistInterruptionState(stellaDataDir, state);
  return { state, threads, turnCompleted: Boolean(conv.turnCompletedAt) };
};

/**
 * Settle a pending reminder when its carrying turn reaches a terminal
 * outcome: success consumes it (deleting the state file once every affected
 * conversation is consumed); failure/interruption clears the pending mark
 * so the next user message re-attaches.
 */
export const resolveRestartReminderOutcome = (
  stellaDataDir: string,
  args: {
    conversationId: string;
    runId?: string;
    succeeded: boolean;
    /** Carrying-turn visibility; hidden turns can't consume an unkeyed reminder. */
    isUserTurn?: boolean;
    now?: number;
  },
): void => {
  const now = args.now ?? Date.now();
  const state = readRestartInterruptionState(stellaDataDir, now);
  if (!state) return;
  const conv = state.conversations[args.conversationId];
  if (!conv?.reminderAttachedAt || conv.reminderConsumedAt) return;
  if (conv.reminderPendingRunId) {
    if (!args.runId || args.runId !== conv.reminderPendingRunId) return;
  } else if (args.isUserTurn === false) {
    // No run-id key to match on — never let a hidden/system turn settle it.
    return;
  }
  if (args.succeeded) {
    state.conversations[args.conversationId] = {
      ...conv,
      reminderConsumedAt: now,
    };
    maybeFinishInterruption(stellaDataDir, state);
    return;
  }
  const {
    reminderAttachedAt: _attachedAt,
    reminderPendingRunId: _pendingRunId,
    ...rest
  } = conv;
  state.conversations[args.conversationId] = rest;
  persistInterruptionState(stellaDataDir, state);
};

// ---------------------------------------------------------------------------
// Text builders (pure).
// ---------------------------------------------------------------------------

const truncateText = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const isSelfUpdateReason = (reason: string): boolean =>
  /self-mod|self-update|desktop-update/i.test(reason);

/** User-visible one-liner appended to chat before the continuation turn. */
export const buildRestartNoticeText = (reason: string): string =>
  isSelfUpdateReason(reason)
    ? "Stella restarted to apply changes — resuming interrupted work."
    : "Stella restarted — resuming interrupted background work.";

export type ThreadStateSentinels = {
  /** `error` values that mean the thread was deliberately paused. */
  pausedReasons: string[];
  /** `error` values stamped by restart/shutdown cancellation sweeps. */
  restartCancelReasons: string[];
};

export const isPausedThreadRecord = (
  record: Pick<RestartThreadRecordLike, "status" | "error">,
  sentinels: ThreadStateSentinels,
): boolean =>
  record.status === "canceled" &&
  typeof record.error === "string" &&
  sentinels.pausedReasons.includes(record.error);

/**
 * Live current-state label for a thread that was running at shutdown.
 * Resolved at read time (no before-state snapshotting).
 */
export const describeCurrentThreadState = (
  record: RestartThreadRecordLike | null,
  sentinels: ThreadStateSentinels,
): { label: string; resumable: boolean; paused: boolean } => {
  if (!record) {
    return { label: "no longer tracked", resumable: false, paused: false };
  }
  switch (record.status) {
    case "running":
      return { label: "already running again", resumable: false, paused: false };
    case "completed":
      return {
        label: record.result
          ? `completed — ${truncateText(record.result, 160)}`
          : "completed",
        resumable: false,
        paused: false,
      };
    case "error":
      return {
        label: record.error
          ? `failed — ${truncateText(record.error, 160)}`
          : "failed",
        resumable: true,
        paused: false,
      };
    case "canceled": {
      if (isPausedThreadRecord(record, sentinels)) {
        return {
          label: "paused — leave paused unless the user asks",
          resumable: false,
          paused: true,
        };
      }
      if (
        typeof record.error === "string" &&
        sentinels.restartCancelReasons.includes(record.error)
      ) {
        return {
          label: "canceled by the restart — resumable via send_input",
          resumable: true,
          paused: false,
        };
      }
      return {
        label: record.error
          ? `canceled — ${truncateText(record.error, 160)}`
          : "canceled",
        resumable: true,
        paused: false,
      };
    }
  }
};

export type RestartThreadFact = {
  threadId: string;
  description: string;
  agentType: string;
  stateLabel: string;
};

const formatTimestamp = (ms: number): string => new Date(ms).toISOString();

/**
 * Synthetic orchestrator prompt for the boot-time continuation turn. Facts
 * only — the orchestrator decides what actually resumes.
 */
export const buildRestartContinuationPrompt = (args: {
  reason: string;
  shutdownAt: number;
  bootAt: number;
  threads: RestartThreadFact[];
  pausedThreads: Array<{ threadId: string; description: string }>;
}): string => {
  const lines: string[] = [
    "[Stella runtime] Stella restarted and interrupted background agent work.",
    `Reason: ${args.reason}. Shutdown at ${formatTimestamp(args.shutdownAt)}; back up at ${formatTimestamp(args.bootAt)}.`,
    "",
    "Threads that were running when the restart hit:",
    ...args.threads.map(
      (thread) =>
        `- ${thread.threadId} (${thread.agentType}) — "${truncateText(thread.description, 200)}". Current state: ${thread.stateLabel}`,
    ),
  ];
  if (args.pausedThreads.length > 0) {
    lines.push(
      "",
      "Paused threads in this conversation (for awareness only — do NOT resume them unless the user asks):",
      ...args.pausedThreads.map(
        (thread) =>
          `- ${thread.threadId} — "${truncateText(thread.description, 200)}"`,
      ),
    );
  }
  lines.push(
    "",
    "Decide which interrupted threads should continue and resume each one with send_input(threadId, ...) instructing it to continue from where it left off. Leave paused threads paused. Then tell the user briefly what you resumed (or that nothing needed resuming).",
  );
  return lines.join("\n");
};

/**
 * Hidden `<system-reminder>` body attached to the first user message after a
 * restart that interrupted agent work: a one-line notice plus the CURRENT
 * state of the threads that were running at shutdown. Brief only when the
 * synthetic turn for THIS conversation actually completed.
 */
export const buildRestartReminderText = (args: {
  reason: string;
  shutdownAt: number;
  syntheticTurnCompleted: boolean;
  threads: RestartThreadFact[];
}): string => {
  const lines: string[] = [
    `Stella restarted/quit at ${formatTimestamp(args.shutdownAt)} (reason: ${args.reason}) while background agent threads were running. Current state of those threads:`,
    ...args.threads.map(
      (thread) =>
        `- ${thread.threadId} — "${truncateText(thread.description, 200)}": ${thread.stateLabel}`,
    ),
    args.syntheticTurnCompleted
      ? "An automatic resume turn already ran after the restart and surfaced this state — treat this as confirmation and do not duplicate resumption."
      : "No automatic resume turn ran for this conversation. If any of these threads should continue, resume them with send_input; leave paused threads paused.",
  ];
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Boot-time fire.
// ---------------------------------------------------------------------------

export type RestartContinuationFireDeps = {
  stellaDataDir: string;
  env: EnvLike;
  sentinels: ThreadStateSentinels;
  getAgentRecord: (threadId: string) => RestartThreadRecordLike | null;
  listAgentRecordsByStatus: (
    status: RestartThreadRecordLike["status"],
  ) => RestartThreadRecordLike[];
  appendLocalChatEvent: (args: {
    conversationId: string;
    type: string;
    payload: Record<string, unknown>;
  }) => void;
  runAutomationTurn: (args: {
    conversationId: string;
    userPrompt: string;
  }) => Promise<{ status: string; finalText?: string; error?: string }>;
  now?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

const MAX_PAUSED_THREADS_LISTED = 8;

const buildThreadFacts = (
  refs: RestartInterruptedThreadRef[],
  deps: Pick<RestartContinuationFireDeps, "getAgentRecord" | "sentinels">,
): RestartThreadFact[] =>
  refs.map((ref) => {
    const record = deps.getAgentRecord(ref.threadId);
    const current = describeCurrentThreadState(record, deps.sentinels);
    return {
      threadId: ref.threadId,
      description: record?.description ?? "(unknown task)",
      agentType: record?.agentType ?? "unknown",
      stateLabel: current.label,
    };
  });

/**
 * Boot-time synthetic continuation turn. Per affected conversation:
 * claim → visible chat notice → real orchestrator turn (engine-agnostic;
 * queues behind any in-flight user turn) → record completed/failed.
 *
 * Claims are per-conversation and persisted immediately before EACH
 * dispatch, so an early conversation's crash/hang never marks later
 * conversations handled — they stay unclaimed and their reminder remains
 * the full-guidance primary path. A claim is also the re-fire latch: a
 * claimed-but-failed conversation is not retried by the turn mechanism
 * (the reminder covers it).
 */
export const fireRestartContinuationTurn = async (
  deps: RestartContinuationFireDeps,
): Promise<{
  fired: boolean;
  conversationIds: string[];
  outcomes: Record<string, "completed" | "failed" | "skipped">;
}> => {
  const now = deps.now ?? Date.now();
  const outcomes: Record<string, "completed" | "failed" | "skipped"> = {};
  if (!isRestartContinuationTurnEnabled(deps.env)) {
    return { fired: false, conversationIds: [], outcomes };
  }
  const state = readRestartInterruptionState(deps.stellaDataDir, now);
  if (!state) {
    return { fired: false, conversationIds: [], outcomes };
  }
  const candidates = stateConversationIds(state);
  if (candidates.length === 0) {
    return { fired: false, conversationIds: [], outcomes };
  }

  let dispatchedAny = false;
  const dispatchedConversationIds: string[] = [];
  for (const conversationId of candidates) {
    // Re-read per conversation: the reminder hooks share this process and
    // may have mutated the state on disk while an earlier conversation's
    // turn was awaited. A single in-memory copy would clobber their marks.
    const fresh = readRestartInterruptionState(deps.stellaDataDir, Date.now());
    if (!fresh) break;
    const conv = fresh.conversations[conversationId];
    // Skip conversations already claimed by a previous fire attempt and
    // conversations whose reminder is already pending/consumed (the user
    // messaged before the boot trigger — the reminder owns recovery there).
    if (
      conv?.turnClaimedAt ||
      conv?.reminderAttachedAt ||
      conv?.reminderConsumedAt
    ) {
      outcomes[conversationId] = "skipped";
      continue;
    }
    // Claim THIS conversation only, durably, before dispatching. If the
    // claim cannot be persisted, skip the dispatch: an unpersisted claim
    // could double-fire after a crash, while skipping just leaves the
    // reminder as the (full-guidance) recovery path.
    fresh.conversations[conversationId] = {
      ...conv,
      turnClaimedAt: Date.now(),
    };
    if (!persistInterruptionState(deps.stellaDataDir, fresh)) {
      deps.log?.("restart-continuation: failed to persist turn claim", {
        conversationId,
      });
      outcomes[conversationId] = "skipped";
      continue;
    }
    dispatchedAny = true;
    dispatchedConversationIds.push(conversationId);

    const refs = state.threads.filter(
      (thread) => thread.conversationId === conversationId,
    );
    const facts = buildThreadFacts(refs, deps);
    const interruptedIds = new Set(refs.map((ref) => ref.threadId));
    const pausedThreads = deps
      .listAgentRecordsByStatus("canceled")
      .filter(
        (record) =>
          record.conversationId === conversationId &&
          !interruptedIds.has(record.threadId) &&
          isPausedThreadRecord(record, deps.sentinels),
      )
      .slice(0, MAX_PAUSED_THREADS_LISTED)
      .map((record) => ({
        threadId: record.threadId,
        description: record.description,
      }));

    try {
      deps.appendLocalChatEvent({
        conversationId,
        type: "assistant_message",
        payload: {
          text: buildRestartNoticeText(state.reason),
          source: RESTART_CONTINUATION_CHAT_SOURCE,
        },
      });
    } catch (error) {
      deps.log?.("restart-continuation: failed to append chat notice", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const prompt = buildRestartContinuationPrompt({
      reason: state.reason,
      shutdownAt: state.shutdownAt,
      bootAt: state.bootAt,
      threads: facts,
      pausedThreads,
    });
    let succeeded = false;
    try {
      const result = await deps.runAutomationTurn({
        conversationId,
        userPrompt: prompt,
      });
      succeeded = result.status === "ok";
      if (succeeded && result.finalText?.trim()) {
        deps.appendLocalChatEvent({
          conversationId,
          type: "assistant_message",
          payload: {
            text: result.finalText,
            source: RESTART_CONTINUATION_CHAT_SOURCE,
          },
        });
      } else if (!succeeded) {
        deps.log?.("restart-continuation: continuation turn failed", {
          conversationId,
          error: result.error ?? "unknown",
        });
      }
    } catch (error) {
      deps.log?.("restart-continuation: continuation turn threw", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Record the real outcome. Success is only claimed AFTER it happened;
    // anything else leaves the conversation failed-claimed so the reminder
    // stays full guidance. Re-read before writing so reminder marks made
    // while the turn ran are preserved; a persistence failure degrades the
    // same way (state on disk still shows an unfinished claim).
    const afterTurn = readRestartInterruptionState(
      deps.stellaDataDir,
      Date.now(),
    );
    outcomes[conversationId] = succeeded ? "completed" : "failed";
    if (afterTurn) {
      afterTurn.conversations[conversationId] = {
        ...afterTurn.conversations[conversationId],
        ...(succeeded
          ? { turnCompletedAt: Date.now() }
          : { turnFailedAt: Date.now() }),
      };
      if (!persistInterruptionState(deps.stellaDataDir, afterTurn)) {
        deps.log?.("restart-continuation: failed to persist turn outcome", {
          conversationId,
          succeeded,
        });
      }
    }
  }
  return {
    fired: dispatchedAny,
    conversationIds: dispatchedConversationIds,
    outcomes,
  };
};
