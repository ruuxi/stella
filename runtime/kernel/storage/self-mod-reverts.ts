/**
 * Ledger of self-mod reverts the user has triggered from the inline
 * "Undo changes" affordance in chat.
 *
 * Pairs with the revert-notice hook in
 * `runtime/extensions/stella-runtime/hooks/revert-notice.hook.ts`.
 *
 * Two-slot per-row consumption ladder:
 *
 *   - **Orchestrator slot** (`consumed_by_orchestrator`) — drained when
 *     the orchestrator's `before_user_message` fires for a real user
 *     turn on the conversation that produced the reverted commit. The
 *     orchestrator always sees the notice on the next user turn so it
 *     can adjust strategy / craft a follow-up `send_input` informed by
 *     the undo.
 *   - **Origin-thread slot** (`consumed_by_origin_thread`) — drained
 *     when a `before_user_message` fires whose `payload.threadKey`
 *     matches the reverted commit's `Stella-Thread` trailer (i.e. the
 *     orchestrator resumed the specific subagent that did the work,
 *     via `send_input`). That resumed agent then sees the same notice
 *     so it doesn't re-apply the change it just made.
 *
 * Both slots are independent: a row can be consumed by the orchestrator
 * and never by the origin thread (user never goes back to that
 * subagent — the row simply sits dormant). A row with no
 * `origin_thread_key` (legacy commit predating the trailer) auto-fills
 * `consumed_by_origin_thread = 1` at insert time so the half-consumed
 * state never lingers.
 */
import crypto from "node:crypto";
import type { SqliteDatabase } from "./shared.js";

export type SelfModRevertRecord = {
  revertId: string;
  conversationId: string;
  originThreadKey: string | null;
  featureId: string;
  files: string[];
  revertedAt: number;
  consumedByOrchestrator: boolean;
  consumedByOriginThread: boolean;
};

type SelfModRevertRow = {
  revert_id: string;
  conversation_id: string;
  origin_thread_key: string | null;
  feature_id: string;
  files_json: string;
  reverted_at: number;
  consumed_by_orchestrator: number;
  consumed_by_origin_thread: number;
};

const parseFiles = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const toRecord = (row: SelfModRevertRow): SelfModRevertRecord => ({
  revertId: row.revert_id,
  conversationId: row.conversation_id,
  originThreadKey: row.origin_thread_key ?? null,
  featureId: row.feature_id,
  files: parseFiles(row.files_json),
  revertedAt: row.reverted_at,
  consumedByOrchestrator: row.consumed_by_orchestrator === 1,
  consumedByOriginThread: row.consumed_by_origin_thread === 1,
});

export const recordSelfModRevert = (
  db: SqliteDatabase,
  args: {
    conversationId: string;
    /**
     * The agent thread that authored the reverted commit. Null when the
     * reverted commit predates the `Stella-Thread` trailer; in that case
     * the origin-thread slot is auto-marked consumed so the half-pending
     * state never lingers.
     */
    originThreadKey?: string | null;
    featureId: string;
    files: string[];
    revertedAt?: number;
  },
): SelfModRevertRecord => {
  const revertId = crypto.randomUUID();
  const revertedAt = args.revertedAt ?? Date.now();
  const filesJson = JSON.stringify(args.files);
  const originThreadKey = args.originThreadKey?.trim() || null;
  // If we have no origin thread to route to, the "origin thread" slot
  // is vacuously satisfied — mark it consumed at insert time so the
  // row is fully drained as soon as the orchestrator picks it up.
  const consumedByOriginThread = originThreadKey ? 0 : 1;
  db.prepare(
    `INSERT INTO self_mod_reverts (
       revert_id,
       conversation_id,
       origin_thread_key,
       feature_id,
       files_json,
       reverted_at,
       consumed_by_orchestrator,
       consumed_by_origin_thread
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    revertId,
    args.conversationId,
    originThreadKey,
    args.featureId,
    filesJson,
    revertedAt,
    consumedByOriginThread,
  );
  return {
    revertId,
    conversationId: args.conversationId,
    originThreadKey,
    featureId: args.featureId,
    files: [...args.files],
    revertedAt,
    consumedByOrchestrator: false,
    consumedByOriginThread: consumedByOriginThread === 1,
  };
};

/**
 * Pending (unconsumed-by-orchestrator) reverts for a conversation, in
 * `revertedAt` order. Used by the revert-notice hook on the
 * orchestrator's `before_user_message`.
 */
export const listPendingOrchestratorReverts = (
  db: SqliteDatabase,
  conversationId: string,
): SelfModRevertRecord[] => {
  const rows = db
    .prepare(
      `SELECT
         revert_id,
         conversation_id,
         origin_thread_key,
         feature_id,
         files_json,
         reverted_at,
         consumed_by_orchestrator,
         consumed_by_origin_thread
       FROM self_mod_reverts
       WHERE conversation_id = ?
         AND consumed_by_orchestrator = 0
       ORDER BY reverted_at ASC, revert_id ASC`,
    )
    .all(conversationId) as SelfModRevertRow[];
  return rows.map(toRecord);
};

/**
 * Pending (unconsumed-by-origin-thread) reverts whose origin thread key
 * matches the given thread key. Used by the revert-notice hook on a
 * subagent's `before_user_message` when the orchestrator has resumed
 * the specific thread that produced the reverted commit.
 */
export const listPendingOriginThreadReverts = (
  db: SqliteDatabase,
  originThreadKey: string,
): SelfModRevertRecord[] => {
  const rows = db
    .prepare(
      `SELECT
         revert_id,
         conversation_id,
         origin_thread_key,
         feature_id,
         files_json,
         reverted_at,
         consumed_by_orchestrator,
         consumed_by_origin_thread
       FROM self_mod_reverts
       WHERE origin_thread_key = ?
         AND consumed_by_origin_thread = 0
       ORDER BY reverted_at ASC, revert_id ASC`,
    )
    .all(originThreadKey) as SelfModRevertRow[];
  return rows.map(toRecord);
};

export const markSelfModRevertsOrchestratorConsumed = (
  db: SqliteDatabase,
  revertIds: string[],
): void => {
  if (revertIds.length === 0) return;
  const placeholders = revertIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE self_mod_reverts
     SET consumed_by_orchestrator = 1
     WHERE revert_id IN (${placeholders})`,
  ).run(...revertIds);
};

export const markSelfModRevertsOriginThreadConsumed = (
  db: SqliteDatabase,
  revertIds: string[],
): void => {
  if (revertIds.length === 0) return;
  const placeholders = revertIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE self_mod_reverts
     SET consumed_by_origin_thread = 1
     WHERE revert_id IN (${placeholders})`,
  ).run(...revertIds);
};
