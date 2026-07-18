import fs from "node:fs";
import path from "node:path";

/**
 * Restart-with-continuation: auto-resume of orchestrator/agent work after a
 * Stella self-restart (self-mod apply, dev relaunch, or any graceful quit).
 *
 * Two cooperating one-shot artifacts, both living in `stellaDataDir`:
 *
 *  1. SHUTDOWN RECORD (`restart-continuation.json`) — written by the HOST at
 *     restart initiation (worker restart, host stop / app quit). Minimal on
 *     purpose: `{ reason, createdAt }`. The set of interrupted threads is NOT
 *     recorded here — the durable `runtime_agents` rows with status
 *     `running` at next boot are exactly the threads that were in flight at
 *     shutdown, and they survive even a SIGKILL that skips this record.
 *
 *  2. INTERRUPTION STATE (`restart-interruption.json`) — written by the
 *     WORKER at boot when it consumes a fresh shutdown record AND the
 *     `LocalAgentManager` orphan sweep found threads that were running at
 *     shutdown. Everything else (descriptions, current thread status) is
 *     resolved live at read time. Consumed by:
 *       - the boot-time synthetic continuation turn (`fireRestartContinuationTurn`,
 *         marks `syntheticTurnFiredAt` so it fires exactly once), and
 *       - the next-user-message hidden system reminder (per-conversation
 *         consumption via `consumeRestartReminderForConversation`).
 *
 * Guards: env gating, a staleness window on the shutdown record (an old
 * record produces neither a turn nor a reminder), a 24h GC on the
 * interruption state, and the strict "idle at shutdown → nothing at all"
 * rule (no running rows at boot → no state file).
 *
 * This module must stay import-light (node:fs/path only): the host process
 * imports the record-writing half and must not pull the kernel agent stack.
 */

export const RESTART_CONTINUATION_RECORD_FILE = "restart-continuation.json";
export const RESTART_INTERRUPTION_STATE_FILE = "restart-interruption.json";

/** Shutdown records older than this at boot are discarded unread. */
export const RESTART_CONTINUATION_MAX_RECORD_AGE_MS = 15 * 60_000;
/** Interruption state older than this (since boot) is garbage-collected. */
export const RESTART_INTERRUPTION_STATE_MAX_AGE_MS = 24 * 60 * 60_000;

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
  /** e.g. "self-mod-apply-process-restart", "runtime-reload", "app-shutdown". */
  reason: string;
  createdAt: number;
};

export type RestartInterruptedThreadRef = {
  threadId: string;
  conversationId: string;
};

export type RestartInterruptionState = {
  version: 1;
  reason: string;
  shutdownAt: number;
  bootAt: number;
  /** Threads whose durable rows were `running` at boot (= running at shutdown). */
  threads: RestartInterruptedThreadRef[];
  /** Set once when the boot-time synthetic continuation turn is dispatched. */
  syntheticTurnFiredAt?: number;
  /** Conversations whose next-user-message reminder already attached. */
  reminderConsumedConversationIds?: string[];
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

const readJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
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
 * Persist the shutdown record. Synchronous and best-effort by design: the
 * call sites are teardown paths (host `stop()`, pre-worker-restart) that may
 * not survive long enough for async IO.
 */
export const writeRestartShutdownRecord = (
  stellaDataDir: string,
  args: { reason: string; now?: number },
): boolean => {
  try {
    const record: RestartShutdownRecord = {
      version: 1,
      reason: args.reason.trim() || "restart",
      createdAt: args.now ?? Date.now(),
    };
    fs.writeFileSync(recordPath(stellaDataDir), JSON.stringify(record), "utf8");
    return true;
  } catch {
    return false;
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
  return {
    version: 1,
    reason: record.reason,
    createdAt: record.createdAt,
  };
};

/**
 * Read AND delete the shutdown record (single consumption point — the
 * delete-first discipline is what makes the whole feature fire at most once
 * per restart, with no restart loops).
 */
export const consumeRestartShutdownRecord = (
  stellaDataDir: string,
): RestartShutdownRecord | null => {
  const filePath = recordPath(stellaDataDir);
  if (!fs.existsSync(filePath)) return null;
  const parsed = parseShutdownRecord(readJsonFile(filePath));
  deleteFileSilently(filePath);
  return parsed;
};

/** True when a shutdown record file already exists (fresh or not). */
export const hasRestartShutdownRecord = (stellaDataDir: string): boolean =>
  fs.existsSync(recordPath(stellaDataDir));

const writeInterruptionState = (
  stellaDataDir: string,
  state: RestartInterruptionState,
) => {
  fs.writeFileSync(statePath(stellaDataDir), JSON.stringify(state), "utf8");
};

const parseInterruptionState = (
  value: unknown,
): RestartInterruptionState | null => {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<RestartInterruptionState>;
  if (state.version !== 1) return null;
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
  return {
    version: 1,
    reason: state.reason,
    shutdownAt: state.shutdownAt,
    bootAt: state.bootAt,
    threads,
    ...(typeof state.syntheticTurnFiredAt === "number"
      ? { syntheticTurnFiredAt: state.syntheticTurnFiredAt }
      : {}),
    ...(Array.isArray(state.reminderConsumedConversationIds)
      ? {
          reminderConsumedConversationIds:
            state.reminderConsumedConversationIds.filter(
              (id): id is string => typeof id === "string",
            ),
        }
      : {}),
  };
};

/**
 * Boot-time conversion: consume the shutdown record and, when it is fresh
 * and agent work was actually interrupted, persist the interruption state
 * that powers both delivery mechanisms.
 *
 * Returns the state when created, null otherwise (no record / stale record /
 * disabled / idle-at-shutdown). Idle shutdowns are strict: no interrupted
 * threads → no state file → no turn AND no reminder.
 */
export const convertRestartShutdownRecordAtBoot = (args: {
  stellaDataDir: string;
  env: EnvLike;
  interruptedThreads: RestartInterruptedThreadRef[];
  now?: number;
}): RestartInterruptionState | null => {
  const now = args.now ?? Date.now();
  if (!isRestartContinuationEnabled(args.env)) {
    // Feature off: drop the record so it can't fire stale after re-enable.
    deleteFileSilently(recordPath(args.stellaDataDir));
    return null;
  }
  const record = consumeRestartShutdownRecord(args.stellaDataDir);
  if (!record) return null;
  if (now - record.createdAt > RESTART_CONTINUATION_MAX_RECORD_AGE_MS) {
    return null;
  }
  if (args.interruptedThreads.length === 0) {
    return null;
  }
  const state: RestartInterruptionState = {
    version: 1,
    reason: record.reason,
    shutdownAt: record.createdAt,
    bootAt: now,
    threads: args.interruptedThreads.map(({ threadId, conversationId }) => ({
      threadId,
      conversationId,
    })),
  };
  try {
    writeInterruptionState(args.stellaDataDir, state);
  } catch {
    return null;
  }
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
    deleteFileSilently(filePath);
    return null;
  }
  return state;
};

const persistInterruptionStateUpdate = (
  stellaDataDir: string,
  state: RestartInterruptionState,
) => {
  try {
    writeInterruptionState(stellaDataDir, state);
  } catch {
    // Best-effort — worst case the reminder repeats once.
  }
};

/**
 * One-shot reminder consumption for a conversation: returns the interrupted
 * threads belonging to `conversationId` the first time it is called for that
 * conversation, marks the conversation consumed, and deletes the state file
 * once every affected conversation has seen its reminder.
 */
export const consumeRestartReminderForConversation = (
  stellaDataDir: string,
  conversationId: string,
  now = Date.now(),
): {
  state: RestartInterruptionState;
  threads: RestartInterruptedThreadRef[];
} | null => {
  const state = readRestartInterruptionState(stellaDataDir, now);
  if (!state) return null;
  const consumed = new Set(state.reminderConsumedConversationIds ?? []);
  if (consumed.has(conversationId)) return null;
  const threads = state.threads.filter(
    (thread) => thread.conversationId === conversationId,
  );
  if (threads.length === 0) return null;
  consumed.add(conversationId);
  const allConversations = new Set(
    state.threads.map((thread) => thread.conversationId),
  );
  const everyConversationConsumed = [...allConversations].every((id) =>
    consumed.has(id),
  );
  if (everyConversationConsumed) {
    deleteFileSilently(statePath(stellaDataDir));
  } else {
    persistInterruptionStateUpdate(stellaDataDir, {
      ...state,
      reminderConsumedConversationIds: [...consumed],
    });
  }
  return { state, threads };
};

/** Mark the synthetic continuation turn dispatched (exactly-once latch). */
export const markRestartContinuationTurnFired = (
  stellaDataDir: string,
  now = Date.now(),
): void => {
  const state = readRestartInterruptionState(stellaDataDir, now);
  if (!state || state.syntheticTurnFiredAt) return;
  persistInterruptionStateUpdate(stellaDataDir, {
    ...state,
    syntheticTurnFiredAt: now,
  });
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
 * state of the threads that were running at shutdown.
 */
export const buildRestartReminderText = (args: {
  reason: string;
  shutdownAt: number;
  syntheticTurnFired: boolean;
  threads: RestartThreadFact[];
}): string => {
  const lines: string[] = [
    `Stella restarted/quit at ${formatTimestamp(args.shutdownAt)} (reason: ${args.reason}) while background agent threads were running. Current state of those threads:`,
    ...args.threads.map(
      (thread) =>
        `- ${thread.threadId} — "${truncateText(thread.description, 200)}": ${thread.stateLabel}`,
    ),
    args.syntheticTurnFired
      ? "An automatic resume turn already ran after the restart and surfaced this state — treat this as confirmation and do not duplicate resumption."
      : "No automatic resume turn ran after the restart. If any of these threads should continue, resume them with send_input; leave paused threads paused.",
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
 * Boot-time synthetic continuation turn. Reads the interruption state, and —
 * once per interruption — appends a visible chat notice and runs a real
 * orchestrator turn (engine-agnostic: `runAutomationTurn` rides the normal
 * turn pathway, and queues behind any in-flight user turn) per affected
 * conversation carrying the interruption facts.
 */
export const fireRestartContinuationTurn = async (
  deps: RestartContinuationFireDeps,
): Promise<{ fired: boolean; conversationIds: string[] }> => {
  const now = deps.now ?? Date.now();
  if (!isRestartContinuationTurnEnabled(deps.env)) {
    return { fired: false, conversationIds: [] };
  }
  const state = readRestartInterruptionState(deps.stellaDataDir, now);
  if (!state || state.syntheticTurnFiredAt) {
    return { fired: false, conversationIds: [] };
  }
  // A reminder that already covered a conversation supersedes the turn there
  // (the user messaged before the boot trigger ran).
  const reminderConsumed = new Set(state.reminderConsumedConversationIds ?? []);
  const conversationIds = [
    ...new Set(state.threads.map((thread) => thread.conversationId)),
  ].filter((conversationId) => !reminderConsumed.has(conversationId));
  if (conversationIds.length === 0) {
    return { fired: false, conversationIds: [] };
  }
  // Latch BEFORE dispatching: a crash mid-turn must not re-fire on the next
  // boot (the next boot has no shutdown record anyway) or via a late retry.
  markRestartContinuationTurnFired(deps.stellaDataDir, now);

  for (const conversationId of conversationIds) {
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
    try {
      const result = await deps.runAutomationTurn({
        conversationId,
        userPrompt: prompt,
      });
      if (result.status === "ok" && result.finalText?.trim()) {
        deps.appendLocalChatEvent({
          conversationId,
          type: "assistant_message",
          payload: {
            text: result.finalText,
            source: RESTART_CONTINUATION_CHAT_SOURCE,
          },
        });
      } else if (result.status !== "ok") {
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
  }
  return { fired: true, conversationIds };
};
