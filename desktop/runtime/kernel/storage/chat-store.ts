import type { SqliteDatabase } from "./shared.js";
import {
  DEFAULT_CONVERSATION_SETTING_KEY,
  MAX_EVENTS_PER_CONVERSATION,
  type LocalChatAppendEventArgs,
  type LocalChatEventRecord,
  type LocalChatEventRow,
  type LocalChatSyncMessage,
  asFiniteNumber,
  asObject,
  asTrimmedString,
  eventTextFromPayload,
  generateLocalId,
  parseJsonRecord,
  toJsonString,
} from "./shared.js";
import { TranscriptMirror } from "./transcript-mirror.js";

export class ChatStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly mirror: TranscriptMirror,
  ) {}

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

  private upsertConversation(conversationId: string, updatedAt: number): void {
    this.db.prepare(`
      INSERT INTO chat_conversations (id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = CASE
          WHEN excluded.updated_at > updated_at THEN excluded.updated_at
          ELSE updated_at
        END
    `).run(conversationId, updatedAt);
  }

  private upsertEvent(conversationId: string, event: LocalChatEventRecord): void {
    this.db.prepare(`
      INSERT INTO chat_events (
        _id,
        conversation_id,
        timestamp,
        type,
        device_id,
        request_id,
        target_device_id,
        payload_json,
        channel_envelope_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        timestamp = excluded.timestamp,
        type = excluded.type,
        device_id = excluded.device_id,
        request_id = excluded.request_id,
        target_device_id = excluded.target_device_id,
        payload_json = excluded.payload_json,
        channel_envelope_json = excluded.channel_envelope_json
    `).run(
      event._id,
      conversationId,
      event.timestamp,
      event.type,
      event.deviceId ?? null,
      event.requestId ?? null,
      event.targetDeviceId ?? null,
      toJsonString(event.payload),
      toJsonString(event.channelEnvelope),
    );
  }

  private deserializeEventRow(row: LocalChatEventRow): LocalChatEventRecord {
    const payload = parseJsonRecord(row.payloadJson);
    const channelEnvelope = parseJsonRecord(row.channelEnvelopeJson);
    return {
      _id: row._id,
      timestamp: row.timestamp,
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(payload ? { payload } : {}),
      ...(channelEnvelope ? { channelEnvelope } : {}),
    };
  }

  private listAllEventsForConversation(conversationId: string): LocalChatEventRecord[] {
    const rows = this.db.prepare(`
      SELECT
        _id,
        timestamp,
        type,
        device_id AS deviceId,
        request_id AS requestId,
        target_device_id AS targetDeviceId,
        payload_json AS payloadJson,
        channel_envelope_json AS channelEnvelopeJson
      FROM chat_events
      WHERE conversation_id = ?
      ORDER BY timestamp ASC, _id ASC
    `).all(conversationId) as LocalChatEventRow[];
    return rows.map((row) => this.deserializeEventRow(row));
  }

  private rebuildTranscript(conversationId: string): void {
    const rows = this.listAllEventsForConversation(conversationId).map((event) => ({
      conversationId,
      ...event,
    }));
    this.mirror.writeChatTranscript(conversationId, rows);
  }

  private sanitizeAppendArgs(args: LocalChatAppendEventArgs): {
    conversationId: string;
    event: LocalChatEventRecord;
  } {
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

    return {
      conversationId,
      event: {
        _id: eventId,
        timestamp,
        type,
        ...(deviceId ? { deviceId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(targetDeviceId ? { targetDeviceId } : {}),
        ...(payload ? { payload } : {}),
        ...(channelEnvelope ? { channelEnvelope } : {}),
      },
    };
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const { conversationId, event } = this.sanitizeAppendArgs(args);
    this.withTransaction(() => {
      this.upsertConversation(conversationId, event.timestamp);
      this.upsertEvent(conversationId, event);
    });
    this.rebuildTranscript(conversationId);
    return event;
  }

  getOrCreateDefaultConversationId(): string {
    const existing = this.getSetting(DEFAULT_CONVERSATION_SETTING_KEY);
    if (existing) {
      this.upsertConversation(existing, Date.now());
      return existing;
    }

    const created = generateLocalId();
    const createdAt = Date.now();
    this.withTransaction(() => {
      this.upsertConversation(created, createdAt);
      this.setSetting(DEFAULT_CONVERSATION_SETTING_KEY, created);
    });
    return created;
  }

  listEvents(conversationIdInput: string, maxItems = 200): LocalChatEventRecord[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const normalizedLimit = Math.max(1, Math.floor(maxItems));
    const rows = this.db.prepare(`
      SELECT
        _id,
        timestamp,
        type,
        device_id AS deviceId,
        request_id AS requestId,
        target_device_id AS targetDeviceId,
        payload_json AS payloadJson,
        channel_envelope_json AS channelEnvelopeJson
      FROM (
        SELECT
          _id,
          timestamp,
          type,
          device_id,
          request_id,
          target_device_id,
          payload_json,
          channel_envelope_json
        FROM chat_events
        WHERE conversation_id = ?
        ORDER BY timestamp DESC, _id DESC
        LIMIT ?
      ) recent
      ORDER BY timestamp ASC, _id ASC
    `).all(conversationId, normalizedLimit) as LocalChatEventRow[];

    return rows.map((row) => this.deserializeEventRow(row));
  }

  getEventCount(conversationIdInput: string): number {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_events
      WHERE conversation_id = ?
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
        _id,
        timestamp,
        type,
        device_id AS deviceId,
        payload_json AS payloadJson
      FROM (
        SELECT
          _id,
          timestamp,
          type,
          device_id,
          payload_json
        FROM chat_events
        WHERE conversation_id = ?
          AND type IN ('user_message', 'assistant_message')
        ORDER BY timestamp DESC, _id DESC
        LIMIT ?
      ) recent
      ORDER BY timestamp ASC, _id ASC
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
    const row = this.db.prepare(`
      SELECT local_message_id AS localMessageId
      FROM chat_sync_checkpoints
      WHERE conversation_id = ?
    `).get(conversationId) as { localMessageId?: unknown } | undefined;
    return typeof row?.localMessageId === "string" && row.localMessageId.length > 0
      ? row.localMessageId
      : null;
  }

  setSyncCheckpoint(conversationIdInput: string, localMessageIdInput: string): void {
    const conversationId = this.sanitizeConversationId(conversationIdInput);
    const localMessageId = asTrimmedString(localMessageIdInput);
    if (!localMessageId) return;

    this.db.prepare(`
      INSERT INTO chat_sync_checkpoints (conversation_id, local_message_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        local_message_id = excluded.local_message_id,
        updated_at = excluded.updated_at
    `).run(conversationId, localMessageId, Date.now());
  }
}
