/**
 * Phase 2 local -> cloud sync batching.
 *
 * Uses _sync_state to track dirty local rows and emits normalized payloads
 * for backend/convex/sync/local_cloud.ts.
 */

import { getDb, rawQuery, rawRun } from "./db.js";

export type SyncTableName =
  | "conversations"
  | "events"
  | "attachments"
  | "tasks"
  | "threads"
  | "thread_messages"
  | "memories"
  | "memory_extraction_batches"
  | "heartbeat_configs"
  | "cron_jobs"
  | "usage_logs"
  | "self_mod_features"
  | "store_installs"
  | "canvas_states"
  | "user_preferences";

export const LOCAL_SYNC_TABLES: SyncTableName[] = [
  "conversations",
  "events",
  "attachments",
  "tasks",
  "threads",
  "thread_messages",
  "memories",
  "memory_extraction_batches",
  "heartbeat_configs",
  "cron_jobs",
  "usage_logs",
  "self_mod_features",
  "store_installs",
  "canvas_states",
  "user_preferences",
];

const LOCAL_SYNC_TABLE_SET = new Set<string>(LOCAL_SYNC_TABLES);
const RESERVED_MAPPING_PREFIX = "local_sync_map:";

type DirtySyncStateRow = {
  id: string;
  table_name: string;
  record_id: string;
  remote_id?: string | null;
  dirty: number;
  synced_at?: number | null;
};

type PreparedUpsert = {
  syncStateId: string;
  table: SyncTableName;
  localId: string;
  row: Record<string, unknown>;
};

type PreparedDelete = {
  syncStateId: string;
  table: SyncTableName;
  localId: string;
};

export type PreparedSyncBatch = {
  upserts: PreparedUpsert[];
  deletes: PreparedDelete[];
};

type SyncSuccessItem = {
  table: SyncTableName;
  localId: string;
  remoteId?: string;
};

export type LocalSyncBatchResult = {
  upserts: SyncSuccessItem[];
  deletes: SyncSuccessItem[];
  errors: Array<{ table: SyncTableName; localId: string; message: string }>;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return false;
};

const asArray = <T = unknown>(value: unknown): T[] | undefined =>
  Array.isArray(value) ? (value as T[]) : undefined;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizeForSync = (
  table: SyncTableName,
  row: Record<string, unknown>,
): Record<string, unknown> | null => {
  switch (table) {
    case "conversations":
      return {
        title: asString(row.title),
        isDefault: asBoolean(row.is_default),
        createdAt: asNumber(row.created_at) ?? Date.now(),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
        tokenCount: asNumber(row.token_count),
        lastIngestedAt: asNumber(row.last_ingested_at),
        lastExtractionAt: asNumber(row.last_extraction_at),
        lastExtractionTokenCount: asNumber(row.last_extraction_token_count),
      };

    case "events":
      return {
        conversationLocalId: asString(row.conversation_id),
        timestamp: asNumber(row.timestamp) ?? Date.now(),
        type: asString(row.type),
        deviceId: asString(row.device_id),
        requestId: asString(row.request_id),
        targetDeviceId: asString(row.target_device_id),
        payload: row.payload ?? {},
        channelEnvelope: row.channel_envelope ?? undefined,
      };

    case "attachments":
      return {
        conversationLocalId: asString(row.conversation_id),
        deviceId: asString(row.device_id),
        storageKey: asString(row.storage_key),
        url: asString(row.url),
        mimeType: asString(row.mime_type),
        size: asNumber(row.size),
        createdAt: asNumber(row.created_at) ?? Date.now(),
      };

    case "tasks":
      return {
        conversationLocalId: asString(row.conversation_id),
        parentTaskLocalId: asString(row.parent_task_id),
        description: asString(row.description),
        prompt: asString(row.prompt),
        agentType: asString(row.agent_type),
        status: asString(row.status),
        taskDepth: asNumber(row.task_depth),
        model: asString(row.model),
        commandId: asString(row.command_id),
        result: asString(row.result),
        error: asString(row.error),
        statusUpdates: asArray(row.status_updates),
        createdAt: asNumber(row.created_at) ?? Date.now(),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
        completedAt: asNumber(row.completed_at),
      };

    case "threads":
      return {
        conversationLocalId: asString(row.conversation_id),
        name: asString(row.name),
        status: asString(row.status),
        summary: asString(row.summary),
        messageCount: asNumber(row.message_count),
        totalTokenEstimate: asNumber(row.total_token_estimate),
        createdAt: asNumber(row.created_at) ?? Date.now(),
        lastUsedAt: asNumber(row.last_used_at) ?? Date.now(),
        resurfacedAt: asNumber(row.resurfaced_at),
        closedAt: asNumber(row.closed_at),
      };

    case "thread_messages":
      return {
        threadLocalId: asString(row.thread_id),
        ordinal: asNumber(row.ordinal),
        role: asString(row.role),
        content: asString(row.content),
        toolCallId: asString(row.tool_call_id),
        tokenEstimate: asNumber(row.token_estimate),
        createdAt: asNumber(row.created_at) ?? Date.now(),
      };

    case "memories":
      return {
        conversationLocalId: asString(row.conversation_id),
        content: asString(row.content),
        embedding: asArray<number>(row.embedding),
        accessedAt: asNumber(row.accessed_at) ?? Date.now(),
        createdAt: asNumber(row.created_at) ?? Date.now(),
        updatedAt: asNumber(row.updated_at),
      };

    case "memory_extraction_batches":
      return {
        conversationLocalId: asString(row.conversation_id),
        trigger: asString(row.trigger),
        windowStart: asNumber(row.window_start),
        windowEnd: asNumber(row.window_end),
        snapshot: asArray(row.snapshot),
        createdAt: asNumber(row.created_at) ?? Date.now(),
      };

    case "heartbeat_configs":
      return {
        conversationLocalId: asString(row.conversation_id),
        enabled: asBoolean(row.enabled),
        intervalMs: asNumber(row.interval_ms),
        prompt: asString(row.prompt),
        checklist: asString(row.checklist),
        ackMaxChars: asNumber(row.ack_max_chars),
        deliver: row.deliver === null ? undefined : asBoolean(row.deliver),
        agentType: asString(row.agent_type),
        activeHours: asObject(row.active_hours),
        targetDeviceId: asString(row.target_device_id),
        lastRunAtMs: asNumber(row.last_run_at_ms),
        nextRunAtMs: asNumber(row.next_run_at_ms),
        lastStatus: asString(row.last_status),
        lastError: asString(row.last_error),
        lastSentText: asString(row.last_sent_text),
        lastSentAtMs: asNumber(row.last_sent_at_ms),
        createdAt: asNumber(row.created_at) ?? Date.now(),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
      };

    case "cron_jobs":
      return {
        conversationLocalId: asString(row.conversation_id),
        name: asString(row.name),
        description: asString(row.description),
        enabled: asBoolean(row.enabled),
        schedule: asObject(row.schedule),
        sessionTarget: asString(row.session_target),
        payload: asObject(row.payload),
        deleteAfterRun:
          row.delete_after_run === null
            ? undefined
            : asBoolean(row.delete_after_run),
        nextRunAtMs: asNumber(row.next_run_at_ms),
        runningAtMs: asNumber(row.running_at_ms),
        lastRunAtMs: asNumber(row.last_run_at_ms),
        lastStatus: asString(row.last_status),
        lastError: asString(row.last_error),
        lastDurationMs: asNumber(row.last_duration_ms),
        lastOutputPreview: asString(row.last_output_preview),
        createdAt: asNumber(row.created_at) ?? Date.now(),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
      };

    case "usage_logs":
      return {
        conversationLocalId: asString(row.conversation_id),
        agentType: asString(row.agent_type),
        model: asString(row.model),
        inputTokens: asNumber(row.input_tokens),
        outputTokens: asNumber(row.output_tokens),
        totalTokens: asNumber(row.total_tokens),
        durationMs: asNumber(row.duration_ms),
        success: asBoolean(row.success),
        fallbackUsed:
          row.fallback_used === null ? undefined : asBoolean(row.fallback_used),
        toolCalls: asNumber(row.tool_calls),
        createdAt: asNumber(row.created_at) ?? Date.now(),
      };

    case "self_mod_features":
      return {
        featureId: asString(row.feature_id),
        conversationLocalId: asString(row.conversation_id),
        name: asString(row.name),
        description: asString(row.description),
        status: asString(row.status),
        batchCount: asNumber(row.batch_count),
        files: asArray<string>(row.files) ?? [],
        createdAt: asNumber(row.created_at) ?? Date.now(),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
      };

    case "store_installs":
      return {
        packageId: asString(row.package_id),
        installedVersion: asString(row.installed_version),
        installedAt: asNumber(row.installed_at) ?? Date.now(),
      };

    case "canvas_states":
      return {
        conversationLocalId: asString(row.conversation_id),
        name: asString(row.name),
        title: asString(row.title),
        url: asString(row.url),
        width: asNumber(row.width),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
      };

    case "user_preferences": {
      const key = asString(row.key);
      if (key?.startsWith(RESERVED_MAPPING_PREFIX)) {
        return null;
      }
      return {
        key,
        value: asString(row.value),
        updatedAt: asNumber(row.updated_at) ?? Date.now(),
      };
    }
  }
};

export const seedLocalSyncState = () => {
  const db = getDb();
  for (const table of LOCAL_SYNC_TABLES) {
    db.prepare(
      `INSERT OR IGNORE INTO _sync_state (id, table_name, record_id, dirty)
       SELECT lower(hex(randomblob(16))), ?, id, 1 FROM ${table}`,
    ).run(table);
  }
};

export const buildLocalSyncBatch = (limit = 100): PreparedSyncBatch => {
  const rows = rawQuery<DirtySyncStateRow>(
    `SELECT id, table_name, record_id, remote_id, dirty, synced_at
       FROM _sync_state
      WHERE dirty = 1
      ORDER BY COALESCE(synced_at, 0) ASC, id ASC
      LIMIT ?`,
    [limit],
  );

  const upserts: PreparedUpsert[] = [];
  const deletes: PreparedDelete[] = [];

  for (const entry of rows) {
    if (!LOCAL_SYNC_TABLE_SET.has(entry.table_name)) {
      // Unknown table entry should not block the queue forever.
      rawRun("UPDATE _sync_state SET dirty = 0, synced_at = ? WHERE id = ?", [
        Date.now(),
        entry.id,
      ]);
      continue;
    }

    const table = entry.table_name as SyncTableName;
    const localRows = rawQuery<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE id = ? LIMIT 1`,
      [entry.record_id],
    );

    if (localRows.length === 0) {
      deletes.push({
        syncStateId: entry.id,
        table,
        localId: entry.record_id,
      });
      continue;
    }

    const normalized = normalizeForSync(table, localRows[0]);
    if (!normalized) {
      // Intentionally skipped row. Mark clean.
      rawRun("UPDATE _sync_state SET dirty = 0, synced_at = ? WHERE id = ?", [
        Date.now(),
        entry.id,
      ]);
      continue;
    }

    upserts.push({
      syncStateId: entry.id,
      table,
      localId: entry.record_id,
      row: normalized,
    });
  }

  return { upserts, deletes };
};

export const applyLocalSyncBatchResult = (
  batch: PreparedSyncBatch,
  result: LocalSyncBatchResult,
) => {
  const now = Date.now();
  const upsertStateByKey = new Map<string, string>();
  const deleteStateByKey = new Map<string, string>();

  for (const item of batch.upserts) {
    upsertStateByKey.set(`${item.table}:${item.localId}`, item.syncStateId);
  }
  for (const item of batch.deletes) {
    deleteStateByKey.set(`${item.table}:${item.localId}`, item.syncStateId);
  }

  for (const success of result.upserts) {
    const key = `${success.table}:${success.localId}`;
    const syncStateId = upsertStateByKey.get(key);
    if (!syncStateId) continue;
    rawRun(
      "UPDATE _sync_state SET dirty = 0, synced_at = ?, remote_id = COALESCE(?, remote_id) WHERE id = ?",
      [now, success.remoteId ?? null, syncStateId],
    );
  }

  for (const success of result.deletes) {
    const key = `${success.table}:${success.localId}`;
    const syncStateId = deleteStateByKey.get(key);
    if (!syncStateId) continue;
    rawRun("DELETE FROM _sync_state WHERE id = ?", [syncStateId]);
  }

  // Keep failed entries dirty, but bump synced_at so other dirty rows can run first.
  for (const error of result.errors) {
    const key = `${error.table}:${error.localId}`;
    const syncStateId = upsertStateByKey.get(key) ?? deleteStateByKey.get(key);
    if (!syncStateId) continue;
    rawRun("UPDATE _sync_state SET synced_at = ? WHERE id = ?", [now, syncStateId]);
  }
};
