import {
  MAX_ACTIVE_RUNTIME_THREADS,
  type RuntimeThreadRecord,
  normalizeRuntimeThreadId,
} from "../runtime-threads.js";
import type { SqliteDatabase } from "./shared.js";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  MAX_RECALL_RESULTS,
  SQLITE_MEMORY_SCAN_LIMIT,
  type LocalChatAppendEventArgs,
  type LocalChatEventRecord,
  type LocalChatEventRow,
  type LocalChatSyncMessage,
  type RuntimeMemory,
  type RuntimeRunEvent,
  type RuntimeThreadMessage,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  escapeSqlLike,
  eventTextFromPayload,
  generateLocalId,
  parseJsonRecord,
  parseRuntimeThreadPayload,
  scoreMemoryMatches,
  toJsonString,
  toJsonTags,
  toJsonValueString,
} from "./shared.js";
import {
  countVisibleChatMessageEvents,
  sliceEventsByVisibleMessageWindow,
  type LocalChatEventWindowMode,
} from "../../chat-event-visibility.js";

type SessionRow = {
  id: string;
  syncCheckpointMessageId: string | null;
};

type ThreadMessageRow = {
  timestamp: number;
  role: "user" | "assistant" | "toolResult";
  dataJson: string | null;
};

type MemoryRow = {
  timestamp: number;
  conversationId: string;
  payloadJson: string | null;
};

export type PersistedTaskRecord = {
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  taskDepth: number;
  maxTaskDepth?: number;
  parentTaskId?: string;
  toolsAllowlistOverride?: string[];
  selfModMetadata?: {
    featureId?: string;
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update";
    displayName?: string;
    description?: string;
  };
  status: "running" | "completed" | "error" | "canceled";
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  updatedAt: number;
};

const parseJsonValue = <T>(value: string | null): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const parseStringArray = (value: string | null): string[] | undefined => {
  const parsed = parseJsonValue<unknown>(value);
  if (!Array.isArray(parsed)) return undefined;
  const strings = parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return strings.length > 0 ? strings : undefined;
};

const eventRoleForType = (type: string): string => {
  switch (type) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "tool_request":
    case "tool_result":
      return "tool";
    default:
      return "system";
  }
};

export class SessionStore {
  constructor(private readonly db: SqliteDatabase) {}

  private withTransaction(work: () => void): void {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare(`
      SELECT value
      FROM settings
      WHERE key = ?
    `).get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.length > 0
      ? row.value
      : null;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  private sanitizeConversationId(value: unknown): string {
    const conversationId = asTrimmedString(value);
    if (!conversationId) {
      throw new Error("conversationId is required.");
    }
    return conversationId;
  }

  private upsertSession(sessionId: string, updatedAt: number): void {
    this.db.prepare(`
      INSERT INTO session (
        id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES (?, '', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = CASE
          WHEN excluded.updated_at > updated_at THEN excluded.updated_at
          ELSE updated_at
        END
    `).run(sessionId, updatedAt, updatedAt);
  }

  private getSession(sessionId: string): SessionRow | null {
    const row = this.db.prepare(`
      SELECT
        id,
        sync_checkpoint_message_id AS syncCheckpointMessageId
      FROM session
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  private deriveImplicitThreadMetadata(threadKey: string): {
    conversationId: string;
    agentType: string;
  } {
    const subagentMarker = "::subagent::";
    const subagentIndex = threadKey.indexOf(subagentMarker);
    if (subagentIndex > 0) {
      const conversationId = threadKey.slice(0, subagentIndex).trim();
      const remainder = threadKey.slice(subagentIndex + subagentMarker.length);
      const nextDelimiter = remainder.indexOf("::");
      const agentType = nextDelimiter > 0
        ? remainder.slice(0, nextDelimiter).trim()
        : "subagent";
      if (conversationId) {
        return {
          conversationId,
          agentType: agentType || "subagent",
        };
      }
    }

    return {
      conversationId: threadKey,
      agentType: "orchestrator",
    };
  }

  private ensureImplicitThreadRow(threadKey: string): {
    conversationId: string;
    agentType: string;
  } {
    const derived = this.deriveImplicitThreadMetadata(threadKey);
    const now = Date.now();
    this.upsertSession(derived.conversationId, now);
    this.db.prepare(`
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'evicted', ?, ?, NULL)
      ON CONFLICT(thread_key) DO NOTHING
    `).run(
      threadKey,
      derived.conversationId,
      derived.agentType,
      threadKey,
      now,
      now,
    );
    return derived;
  }

  private replaceMessageParts(messageId: string, sessionId: string, parts: Array<{
    type: string;
    toolCallId?: string;
    data: unknown;
    createdAt: number;
  }>): void {
    this.db.prepare(`
      DELETE FROM part
      WHERE message_id = ?
    `).run(messageId);
    const stmt = this.db.prepare(`
      INSERT INTO part (
        id,
        session_id,
        message_id,
        ord,
        type,
        tool_call_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    parts.forEach((part, index) => {
      stmt.run(
        `${messageId}:part:${index}`,
        sessionId,
        messageId,
        index,
        part.type,
        part.toolCallId ?? null,
        toJsonValueString(part.data),
        part.createdAt,
      );
    });
  }

  private upsertEventMessage(args: {
    sessionId: string;
    eventId: string;
    type: string;
    timestamp: number;
    deviceId?: string;
    requestId?: string;
    targetDeviceId?: string;
    payload?: Record<string, unknown>;
    channelEnvelope?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO message (
        id,
        session_id,
        thread_key,
        run_id,
        role,
        type,
        request_id,
        device_id,
        target_device_id,
        agent_type,
        data_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        role = excluded.role,
        type = excluded.type,
        request_id = excluded.request_id,
        device_id = excluded.device_id,
        target_device_id = excluded.target_device_id,
        data_json = excluded.data_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      args.eventId,
      args.sessionId,
      eventRoleForType(args.type),
      args.type,
      args.requestId ?? null,
      args.deviceId ?? null,
      args.targetDeviceId ?? null,
      toJsonString(
        args.channelEnvelope
          ? { channelEnvelope: args.channelEnvelope }
          : undefined,
      ),
      args.timestamp,
      args.timestamp,
    );
    this.replaceMessageParts(args.eventId, args.sessionId, args.payload
      ? [
          {
            type: "payload",
            data: args.payload,
            createdAt: args.timestamp,
          },
        ]
      : []);
  }

  private deserializeEventRow(row: LocalChatEventRow): LocalChatEventRecord {
    const meta = parseJsonRecord(row.channelEnvelopeJson);
    return {
      _id: row._id,
      timestamp: row.timestamp,
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(parseJsonRecord(row.payloadJson) ? { payload: parseJsonRecord(row.payloadJson)! } : {}),
      ...(asObject(meta?.channelEnvelope) ? { channelEnvelope: asObject(meta?.channelEnvelope)! } : {}),
    };
  }

  private listAllEventsForConversation(conversationId: string): LocalChatEventRecord[] {
    const rows = this.db.prepare(`
      SELECT
        message.id AS _id,
        message.created_at AS timestamp,
        message.type AS type,
        message.device_id AS deviceId,
        message.request_id AS requestId,
        message.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        message.data_json AS channelEnvelopeJson
      FROM message
      LEFT JOIN part
        ON part.message_id = message.id
       AND part.ord = 0
      WHERE message.session_id = ?
        AND message.type NOT IN ('thread_message', 'run_event', 'memory')
      ORDER BY message.created_at ASC, message.id ASC
    `).all(conversationId) as LocalChatEventRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const conversationId = this.sanitizeConversationId(args.conversationId);
    const type = asTrimmedString(args.type);
    if (!type) {
      throw new Error("type is required.");
    }
    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now();
    const eventId = asTrimmedString(args.eventId) || `local-${generateLocalId()}`;
    const payload = asObject(args.payload) ?? undefined;
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined;
    const deviceId = asTrimmedString(args.deviceId) || undefined;
    const requestId = asTrimmedString(args.requestId) || undefined;
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined;

    this.withTransaction(() => {
      this.upsertSession(conversationId, timestamp);
      this.upsertEventMessage({
        sessionId: conversationId,
        eventId,
        type,
        timestamp,
        deviceId,
        requestId,
        targetDeviceId,
        payload,
        channelEnvelope,
      });
    });

    return {
      _id: eventId,
      timestamp,
      type,
      ...(deviceId ? { deviceId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(targetDeviceId ? { targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(channelEnvelope ? { channelEnvelope } : {}),
    };
  }

  getOrCreateDefaultConversationId(): string {
    const existing = this.getSetting(DEFAULT_CONVERSATION_SETTING_KEY);
    if (existing) {
      this.upsertSession(existing, Date.now());
      return existing;
    }

    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertSession(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
    });
    return created;
  }

  listEvents(
    conversationIdInput: string,
    maxItems = 200,
    windowMode: LocalChatEventWindowMode = "events",
  ): LocalChatEventRecord[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    if (windowMode === "visible_messages") {
      return sliceEventsByVisibleMessageWindow(
        this.listAllEventsForConversation(conversationId),
        maxItems,
      );
    }

    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.db.prepare(`
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        recent.request_id AS requestId,
        recent.target_device_id AS targetDeviceId,
        part.data_json AS payloadJson,
        recent.data_json AS channelEnvelopeJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type NOT IN ('thread_message', 'run_event', 'memory')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `).all(conversationId, normalizedLimit) as LocalChatEventRow[];

    return rows.map((row) => this.deserializeEventRow(row));
  }

  getEventCount(
    conversationIdInput: string,
    windowMode: LocalChatEventWindowMode = "events",
  ): number {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    if (windowMode === "visible_messages") {
      return countVisibleChatMessageEvents(
        this.listAllEventsForConversation(conversationId),
      );
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM message
      WHERE session_id = ?
        AND type NOT IN ('thread_message', 'run_event', 'memory')
    `).get(conversationId) as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  listSyncMessages(
    conversationIdInput: string,
    maxMessages = MAX_EVENTS_PER_CONVERSATION,
  ): LocalChatSyncMessage[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxMessages));
    const rows = this.db.prepare(`
      SELECT
        recent.id AS _id,
        recent.created_at AS timestamp,
        recent.type AS type,
        recent.device_id AS deviceId,
        part.data_json AS payloadJson
      FROM (
        SELECT *
        FROM message
        WHERE session_id = ?
          AND type IN ('user_message', 'assistant_message')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `).all(conversationId, normalizedLimit) as Array<{
      _id: string;
      timestamp: number;
      type: string;
      deviceId: string | null;
      payloadJson: string | null;
    }>;

    const messages: LocalChatSyncMessage[] = [];
    for (const row of rows) {
      const payload = parseJsonRecord(row.payloadJson);
      const text = eventTextFromPayload(payload);
      if (!text) continue;
      const role = row.type === "user_message" ? "user" : "assistant";
      messages.push({
        localMessageId: row._id,
        role,
        text,
        timestamp: row.timestamp,
        ...(role === "user" && row.deviceId ? { deviceId: row.deviceId } : {}),
      });
    }
    return messages;
  }

  getSyncCheckpoint(conversationIdInput: string): string | null {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    return this.getSession(conversationId)?.syncCheckpointMessageId ?? null;
  }

  setSyncCheckpoint(conversationIdInput: string, localMessageIdInput: string): void {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const localMessageId = asTrimmedString(localMessageIdInput);
    if (!localMessageId) return;
    this.upsertSession(conversationId, Date.now());
    this.db.prepare(`
      UPDATE session
      SET sync_checkpoint_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(localMessageId, Date.now(), conversationId);
  }

  private getThreadConversationId(threadKey: string): string {
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { conversationId?: unknown } | undefined;
    if (typeof row?.conversationId === "string" && row.conversationId.trim().length > 0) {
      return row.conversationId;
    }
    return this.ensureImplicitThreadRow(threadKey).conversationId;
  }

  appendThreadMessage(message: RuntimeThreadMessage): void {
    const threadKey = normalizeRuntimeThreadId(message.threadKey);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    const messageId = `thread:${threadKey}:${generateLocalId()}`;
    this.withTransaction(() => {
      this.upsertSession(conversationId, message.timestamp);
      this.db.prepare(`
        INSERT INTO message (
          id,
          session_id,
          thread_key,
          run_id,
          role,
          type,
          request_id,
          device_id,
          target_device_id,
          agent_type,
          data_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, NULL, ?, 'thread_message', NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        messageId,
        conversationId,
        threadKey,
        message.role,
        message.timestamp,
        message.timestamp,
      );
      this.replaceMessageParts(messageId, conversationId, [
        {
          type: "runtime_thread_payload",
          toolCallId: message.toolCallId,
          data: {
            content: message.content,
            ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
            ...(message.payload ? { payload: message.payload } : {}),
          },
          createdAt: message.timestamp,
        },
      ]);
      this.touchThread(threadKey);
    });
  }

  loadThreadMessages(
    threadKeyInput: string,
    limit?: number,
  ): Array<{
    timestamp: number;
    role: RuntimeThreadMessage["role"];
    content: string;
    toolCallId?: string;
    payload?: RuntimeThreadMessage["payload"];
  }> {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT
        recent.created_at AS timestamp,
        recent.role AS role,
        part.data_json AS dataJson
      FROM (
        SELECT *
        FROM message
        WHERE thread_key = ?
          AND type = 'thread_message'
        ORDER BY created_at DESC, id DESC
        ${normalizedLimit ? "LIMIT ?" : ""}
      ) recent
      LEFT JOIN part
        ON part.message_id = recent.id
       AND part.ord = 0
      ORDER BY recent.created_at ASC, recent.id ASC
    `;
    const rows = (
      normalizedLimit
        ? this.db.prepare(sql).all(threadKey, normalizedLimit)
        : this.db.prepare(sql).all(threadKey)
    ) as ThreadMessageRow[];
    return rows.map((row) => {
      const data = parseJsonValue<{
        content?: unknown;
        toolCallId?: unknown;
        payload?: unknown;
      }>(row.dataJson);
      const payload = data?.payload != null
        ? parseRuntimeThreadPayload(JSON.stringify(data.payload))
        : undefined;
      return {
        timestamp: row.timestamp,
        role: row.role,
        content: typeof data?.content === "string" ? data.content : "",
        ...(typeof data?.toolCallId === "string" ? { toolCallId: data.toolCallId } : {}),
        ...(payload ? { payload } : {}),
      };
    });
  }

  replaceThreadMessages(threadKeyInput: string, nextMessages: RuntimeThreadMessage[]): void {
    const threadKey = normalizeRuntimeThreadId(threadKeyInput);
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    const conversationId = this.getThreadConversationId(threadKey);
    this.withTransaction(() => {
      this.db.prepare(`
        DELETE FROM message
        WHERE thread_key = ?
          AND type = 'thread_message'
      `).run(threadKey);
      for (const message of nextMessages) {
        const messageId = `thread:${threadKey}:${generateLocalId()}`;
        this.db.prepare(`
          INSERT INTO message (
            id,
            session_id,
            thread_key,
            run_id,
            role,
            type,
            request_id,
            device_id,
            target_device_id,
            agent_type,
            data_json,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, NULL, ?, 'thread_message', NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          messageId,
          conversationId,
          threadKey,
          message.role,
          message.timestamp,
          message.timestamp,
        );
        this.replaceMessageParts(messageId, conversationId, [
          {
            type: "runtime_thread_payload",
            toolCallId: message.toolCallId,
            data: {
              content: message.content,
              ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
              ...(message.payload ? { payload: message.payload } : {}),
            },
            createdAt: message.timestamp,
          },
        ]);
      }
      this.touchThread(threadKey);
    });
  }

  archiveCurrentThread(_threadKeyInput: string): string | null {
    return null;
  }

  recordRunEvent(event: RuntimeRunEvent): void {
    const messageId = `run:${event.runId}:${event.seq ?? generateLocalId()}`;
    this.withTransaction(() => {
      this.upsertSession(event.conversationId, event.timestamp);
      this.db.prepare(`
        INSERT INTO message (
          id,
          session_id,
          thread_key,
          run_id,
          role,
          type,
          request_id,
          device_id,
          target_device_id,
          agent_type,
          data_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, NULL, ?, 'system', 'run_event', NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          data_json = excluded.data_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        messageId,
        event.conversationId,
        event.runId,
        event.agentType,
        toJsonString({
          eventType: event.type,
          ...(event.seq == null ? {} : { seq: event.seq }),
        }),
        event.timestamp,
        event.timestamp,
      );
      this.replaceMessageParts(messageId, event.conversationId, [
        {
          type: "run_event",
          toolCallId: event.toolCallId,
          data: event,
          createdAt: event.timestamp,
        },
      ]);
    });
  }

  saveMemory(args: { conversationId: string; content: string; tags?: string[] }): void {
    const content = args.content.trim();
    if (!content) return;
    const tags = args.tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    const timestamp = Date.now();
    const messageId = `memory:${generateLocalId()}`;
    this.withTransaction(() => {
      this.upsertSession(args.conversationId, timestamp);
      this.db.prepare(`
        INSERT INTO message (
          id,
          session_id,
          thread_key,
          run_id,
          role,
          type,
          request_id,
          device_id,
          target_device_id,
          agent_type,
          data_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, NULL, NULL, 'system', 'memory', NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(
        messageId,
        args.conversationId,
        toJsonTags(tags),
        timestamp,
        timestamp,
      );
      this.replaceMessageParts(messageId, args.conversationId, [
        {
          type: "memory",
          data: {
            content,
            ...(tags && tags.length > 0 ? { tags } : {}),
          },
          createdAt: timestamp,
        },
      ]);
    });
  }

  recallMemories(args: { query: string; limit?: number }): RuntimeMemory[] {
    const query = args.query.trim().toLowerCase();
    if (!query) return [];
    const limit = Math.max(1, Math.min(MAX_RECALL_RESULTS, args.limit ?? MAX_RECALL_RESULTS));
    const queryTokens = Array.from(new Set(query.split(/\s+/).filter((token) => token.length > 0)));
    const terms = [query, ...queryTokens];
    const whereClauses = terms.map(() => "lower(payload_search) LIKE ? ESCAPE '\\'");
    const params = terms.map((term) => `%${escapeSqlLike(term)}%`);
    const sql = `
      SELECT
        base.created_at AS timestamp,
        base.session_id AS conversationId,
        base.payloadJson AS payloadJson
      FROM (
        SELECT
          message.created_at,
          message.session_id,
          part.data_json AS payloadJson,
          lower(
            coalesce(json_extract(part.data_json, '$.content'), '')
            || ' '
            || coalesce(message.data_json, '')
          ) AS payload_search
        FROM message
        LEFT JOIN part
          ON part.message_id = message.id
         AND part.ord = 0
        WHERE message.type = 'memory'
      ) base
      ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(" OR ")}` : ""}
      ORDER BY base.created_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(
      ...params,
      SQLITE_MEMORY_SCAN_LIMIT,
    ) as MemoryRow[];
    if (rows.length === 0) return [];
    const normalizedRows: RuntimeMemory[] = rows.map((row) => {
      const payload = parseJsonValue<{ content?: unknown; tags?: unknown }>(row.payloadJson);
      const tags = Array.isArray(payload?.tags)
        ? payload?.tags.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      return {
        timestamp: row.timestamp,
        conversationId: row.conversationId,
        content: typeof payload?.content === "string" ? payload.content : "",
        ...(tags && tags.length > 0 ? { tags } : {}),
      };
    }).filter((row) => row.content.trim().length > 0);
    const scored = scoreMemoryMatches(query, normalizedRows);
    return scored.slice(0, limit).map((entry) => entry.row);
  }

  private deserializeRuntimeThread(row: {
    threadId: string;
    conversationId: string;
    name: string;
    agentType: string;
    status: "active" | "evicted";
    createdAt: number;
    lastUsedAt: number;
    description: string | null;
    summary: string | null;
  }): RuntimeThreadRecord {
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      name: row.name,
      agentType: row.agentType,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.description ? { description: row.description } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
    };
  }

  listActiveThreads(conversationId: string): RuntimeThreadRecord[] {
    const rows = this.db.prepare(`
      SELECT
        thread_key AS threadId,
        runtime_threads.conversation_id AS conversationId,
        name,
        runtime_threads.agent_type AS agentType,
        runtime_threads.status AS status,
        created_at AS createdAt,
        last_used_at AS lastUsedAt,
        runtime_threads.summary AS summary,
        runtime_tasks.description AS description
      FROM runtime_threads
      LEFT JOIN runtime_tasks
        ON runtime_tasks.thread_id = runtime_threads.thread_key
      WHERE runtime_threads.conversation_id = ?
        AND runtime_threads.status = 'active'
      ORDER BY runtime_threads.last_used_at DESC
      LIMIT ?
    `).all(conversationId, MAX_ACTIVE_RUNTIME_THREADS) as Array<{
      threadId: string;
      conversationId: string;
      name: string;
      agentType: string;
      status: "active" | "evicted";
      createdAt: number;
      lastUsedAt: number;
      description: string | null;
      summary: string | null;
    }>;
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }

  resolveOrCreateActiveThread(args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
  }): { threadId: string; reused: boolean } {
    const requestedThreadId = normalizeRuntimeThreadId(args.threadId ?? "");
    const existing = requestedThreadId
      ? this.db.prepare(`
        SELECT
          thread_key AS threadId,
          conversation_id AS conversationId,
          agent_type AS agentType,
          status,
          created_at AS createdAt,
          last_used_at AS lastUsedAt,
          summary
        FROM runtime_threads
        WHERE thread_key = ?
        LIMIT 1
      `).get(requestedThreadId) as {
        threadId: string;
        conversationId: string;
        agentType: string;
        status: "active" | "evicted";
        createdAt: number;
        lastUsedAt: number;
        summary: string | null;
      } | undefined
      : undefined;

    if (existing) {
      if (
        existing.conversationId !== args.conversationId ||
        existing.agentType !== args.agentType
      ) {
        throw new Error(`Thread ${existing.threadId} belongs to a different conversation or agent type.`);
      }
      const activeThreads = this.listActiveThreads(args.conversationId);
      if (
        existing.status !== "active" &&
        activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS
      ) {
        const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (oldest) {
          this.db.prepare(`
            UPDATE runtime_threads
            SET status = 'evicted'
            WHERE thread_key = ?
          `).run(oldest.threadId);
        }
      }
      if (existing.status !== "active") {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'active'
          WHERE thread_key = ?
        `).run(existing.threadId);
      }
      this.touchThread(existing.threadId);
      return {
        threadId: existing.threadId,
        reused: true,
      };
    }

    const activeThreads = this.listActiveThreads(args.conversationId);
    if (activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS) {
      const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'evicted'
          WHERE thread_key = ?
        `).run(oldest.threadId);
      }
    }

    const prefix = "task-";
    const rows = this.db.prepare(`
      SELECT thread_key AS threadId
      FROM runtime_threads
      WHERE agent_type = ?
    `).all(args.agentType) as Array<{ threadId: string }>;
    let nextOrdinal = 1;
    for (const row of rows) {
      if (!row.threadId.startsWith(prefix)) continue;
      const suffix = Number.parseInt(row.threadId.slice(prefix.length), 10);
      if (Number.isFinite(suffix) && suffix >= nextOrdinal) {
        nextOrdinal = suffix + 1;
      }
    }
    const threadId = requestedThreadId || `${prefix}${nextOrdinal}`;
    const now = Date.now();
    this.upsertSession(args.conversationId, now);
    this.db.prepare(`
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
    `).run(
      threadId,
      args.conversationId,
      args.agentType,
      threadId,
      now,
      now,
    );
    return {
      threadId,
      reused: false,
    };
  }

  touchThread(threadKey: string): void {
    this.db.prepare(`
      UPDATE runtime_threads
      SET last_used_at = ?
      WHERE thread_key = ?
    `).run(Date.now(), threadKey);
  }

  getThreadExternalSessionId(threadKey: string): string | undefined {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db.prepare(`
      SELECT external_session_id AS externalSessionId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { externalSessionId?: unknown } | undefined;
    return typeof row?.externalSessionId === "string" &&
      row.externalSessionId.trim().length > 0
      ? row.externalSessionId.trim()
      : undefined;
  }

  setThreadExternalSessionId(
    threadKey: string,
    externalSessionId: string | null | undefined,
  ): void {
    this.ensureImplicitThreadRow(threadKey);
    const normalized =
      typeof externalSessionId === "string" && externalSessionId.trim().length > 0
        ? externalSessionId.trim()
        : null;
    this.db.prepare(`
      UPDATE runtime_threads
      SET external_session_id = ?, last_used_at = ?
      WHERE thread_key = ?
    `).run(normalized, Date.now(), threadKey);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { conversationId?: unknown } | undefined;
    this.db.prepare(`
      UPDATE runtime_threads
      SET summary = ?, last_used_at = ?
      WHERE thread_key = ?
    `).run(trimmed, Date.now(), threadKey);
    if (typeof row?.conversationId === "string" && row.conversationId.length > 0) {
      this.forceOrchestratorReminderOnNextTurn(row.conversationId);
    }
  }

  getThreadName(threadKey: string): string | undefined {
    this.ensureImplicitThreadRow(threadKey);
    const row = this.db.prepare(`
      SELECT name
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { name?: unknown } | undefined;
    return typeof row?.name === "string" && row.name.length > 0 ? row.name : undefined;
  }

  saveTaskRecord(record: PersistedTaskRecord): void {
    this.upsertSession(record.conversationId, record.updatedAt);
    this.db.prepare(`
      INSERT INTO runtime_tasks (
        thread_id,
        conversation_id,
        agent_type,
        description,
        task_depth,
        max_task_depth,
        parent_task_id,
        tools_allowlist_override_json,
        self_mod_metadata_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        agent_type = excluded.agent_type,
        description = excluded.description,
        task_depth = excluded.task_depth,
        max_task_depth = excluded.max_task_depth,
        parent_task_id = excluded.parent_task_id,
        tools_allowlist_override_json = excluded.tools_allowlist_override_json,
        self_mod_metadata_json = excluded.self_mod_metadata_json,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      record.threadId,
      record.conversationId,
      record.agentType,
      record.description,
      record.taskDepth,
      record.maxTaskDepth ?? null,
      record.parentTaskId ?? null,
      toJsonValueString(record.toolsAllowlistOverride) ?? null,
      toJsonValueString(record.selfModMetadata) ?? null,
      record.status,
      record.startedAt,
      record.completedAt ?? null,
      record.result ?? null,
      record.error ?? null,
      record.updatedAt,
    );
  }

  getTaskRecord(threadId: string): PersistedTaskRecord | null {
    const row = this.db.prepare(`
      SELECT
        thread_id AS threadId,
        conversation_id AS conversationId,
        agent_type AS agentType,
        description,
        task_depth AS taskDepth,
        max_task_depth AS maxTaskDepth,
        parent_task_id AS parentTaskId,
        tools_allowlist_override_json AS toolsAllowlistOverrideJson,
        self_mod_metadata_json AS selfModMetadataJson,
        status,
        started_at AS startedAt,
        completed_at AS completedAt,
        result,
        error,
        updated_at AS updatedAt
      FROM runtime_tasks
      WHERE thread_id = ?
      LIMIT 1
    `).get(threadId) as
      | {
          threadId: string;
          conversationId: string;
          agentType: string;
          description: string;
          taskDepth: number;
          maxTaskDepth: number | null;
          parentTaskId: string | null;
          toolsAllowlistOverrideJson: string | null;
          selfModMetadataJson: string | null;
          status: PersistedTaskRecord["status"];
          startedAt: number;
          completedAt: number | null;
          result: string | null;
          error: string | null;
          updatedAt: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      agentType: row.agentType,
      description: row.description,
      taskDepth: row.taskDepth,
      ...(row.maxTaskDepth == null ? {} : { maxTaskDepth: row.maxTaskDepth }),
      ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
      ...(parseStringArray(row.toolsAllowlistOverrideJson)
        ? { toolsAllowlistOverride: parseStringArray(row.toolsAllowlistOverrideJson)! }
        : {}),
      ...(parseJsonValue<PersistedTaskRecord["selfModMetadata"]>(row.selfModMetadataJson)
        ? { selfModMetadata: parseJsonValue<PersistedTaskRecord["selfModMetadata"]>(row.selfModMetadataJson)! }
        : {}),
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updatedAt,
    };
  }

  getOrchestratorReminderState(conversationId: string): {
    shouldInjectDynamicReminder: boolean;
    reminderTokensSinceLastInjection: number;
  } {
    const row = this.db.prepare(`
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as {
      reminderTokensSinceLastInjection?: unknown;
      forceReminderOnNextTurn?: unknown;
    } | undefined;
    const current = typeof row?.reminderTokensSinceLastInjection === "number"
      ? Math.max(0, Math.floor(row.reminderTokensSinceLastInjection))
      : 0;
    const shouldInjectDynamicReminder = row?.forceReminderOnNextTurn === 1;
    return {
      shouldInjectDynamicReminder,
      reminderTokensSinceLastInjection: current,
    };
  }

  updateOrchestratorReminderCounter(args: {
    conversationId: string;
    resetTo?: number;
    incrementBy?: number;
  }): void {
    const currentState = this.db.prepare(`
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(args.conversationId) as {
      reminderTokensSinceLastInjection?: unknown;
      forceReminderOnNextTurn?: unknown;
    } | undefined;
    const current =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    const nextValue = args.resetTo != null
      ? Math.max(0, Math.floor(args.resetTo))
      : Math.max(0, Math.floor(current + (args.incrementBy ?? 0)));
    const forceReminderOnNextTurn = args.resetTo != null
      ? 0
      : currentState?.forceReminderOnNextTurn === 1
        ? 1
        : 0;
    this.db.prepare(`
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = excluded.force_reminder_on_next_turn
    `).run(args.conversationId, nextValue, forceReminderOnNextTurn);
  }

  forceOrchestratorReminderOnNextTurn(conversationId: string): void {
    const currentState = this.db.prepare(`
      SELECT reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { reminderTokensSinceLastInjection?: unknown } | undefined;
    const reminderTokensSinceLastInjection =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    this.db.prepare(`
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = 1
    `).run(conversationId, reminderTokensSinceLastInjection);
  }
}
