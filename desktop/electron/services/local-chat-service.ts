import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

declare const globalThis: typeof global & { Bun?: unknown }

export type LocalChatEventRecord = {
  _id: string
  timestamp: number
  type: string
  deviceId?: string
  requestId?: string
  targetDeviceId?: string
  payload?: Record<string, unknown>
  channelEnvelope?: Record<string, unknown>
}

export type LocalChatAppendEventArgs = {
  conversationId: string
  type: string
  payload?: unknown
  deviceId?: string
  requestId?: string
  targetDeviceId?: string
  channelEnvelope?: unknown
  timestamp?: number
  eventId?: string
}

export type LocalChatSyncMessage = {
  localMessageId: string
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  deviceId?: string
}

export type LocalChatLegacyStore = {
  version?: number
  conversations?: Record<
    string,
    {
      id?: string
      updatedAt?: number
      events?: unknown[]
    }
  >
}

export type ImportLegacyLocalChatPayload = {
  store?: LocalChatLegacyStore | null
  syncCheckpoints?: Record<string, unknown> | null
}

type SqliteStatement = {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close?: () => void
}

type EventRow = {
  _id: string
  timestamp: number
  type: string
  deviceId: string | null
  requestId: string | null
  targetDeviceId: string | null
  payloadJson: string | null
  channelEnvelopeJson: string | null
}

const DB_FILE = 'local-chat.sqlite'
const MAX_EVENTS_PER_CONVERSATION = 2000
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const asTrimmedString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true })
}

const fileSafeId = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_')

const encodeBase32 = (value: number, length: number): string => {
  let remaining = Math.floor(value)
  let output = ''
  for (let index = 0; index < length; index += 1) {
    output = ULID_ALPHABET[remaining % 32] + output
    remaining = Math.floor(remaining / 32)
  }
  return output
}

const generateLocalId = () => {
  const time = encodeBase32(Date.now(), 10)
  const bytes = crypto.randomBytes(16)
  let randomPart = ''
  for (let index = 0; index < 16; index += 1) {
    randomPart += ULID_ALPHABET[bytes[index]! % ULID_ALPHABET.length]
  }
  return `${time}${randomPart}`
}

const toJsonString = (value: unknown): string | null => {
  const record = asObject(value)
  if (!record) return null
  try {
    return JSON.stringify(record)
  } catch {
    return null
  }
}

const parseJsonRecord = (value: string | null): Record<string, unknown> | undefined => {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return asObject(parsed) ?? undefined
  } catch {
    return undefined
  }
}

const eventTextFromPayload = (payload?: Record<string, unknown>) => {
  const text = payload?.text
  return typeof text === 'string' ? text.trim() : ''
}

const toStoredEventRecord = (
  conversationId: string,
  event: LocalChatEventRecord,
) => ({
  conversationId,
  ...event,
})

const sanitizeEventRecord = (value: unknown): LocalChatEventRecord | null => {
  const record = asObject(value)
  if (!record) return null

  const eventId = asTrimmedString(record._id)
  const eventType = asTrimmedString(record.type)
  const timestamp = asFiniteNumber(record.timestamp)
  if (!eventId || !eventType || timestamp == null) {
    return null
  }

  const payload = asObject(record.payload) ?? undefined
  const channelEnvelope = asObject(record.channelEnvelope) ?? undefined
  const deviceId = asTrimmedString(record.deviceId) || undefined
  const requestId = asTrimmedString(record.requestId) || undefined
  const targetDeviceId = asTrimmedString(record.targetDeviceId) || undefined

  return {
    _id: eventId,
    timestamp,
    type: eventType,
    ...(deviceId ? { deviceId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(targetDeviceId ? { targetDeviceId } : {}),
    ...(payload ? { payload } : {}),
    ...(channelEnvelope ? { channelEnvelope } : {}),
  }
}

const openDatabase = (dbPath: string): SqliteDatabase => {
  if (typeof globalThis.Bun !== 'undefined') {
    const bunSqlite = require('bun:sqlite') as {
      Database: new (
        filePath: string,
        options?: { create?: boolean; readonly?: boolean },
      ) => SqliteDatabase
    }
    return new bunSqlite.Database(dbPath, { create: true })
  }

  const BetterSqliteDatabase = require('better-sqlite3') as new (
    filePath: string,
  ) => SqliteDatabase
  return new BetterSqliteDatabase(dbPath)
}

export class LocalChatService {
  private readonly root: string
  private readonly transcriptsDir: string
  private readonly db: SqliteDatabase

  constructor(stellaHome: string) {
    this.root = path.join(stellaHome, 'state', 'local-chat')
    this.transcriptsDir = path.join(this.root, 'transcripts')
    ensureDir(this.root)
    ensureDir(this.transcriptsDir)

    this.db = openDatabase(path.join(this.root, DB_FILE))
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec('PRAGMA temp_store = MEMORY;')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        _id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        device_id TEXT,
        request_id TEXT,
        target_device_id TEXT,
        payload_json TEXT,
        channel_envelope_json TEXT
      );
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_chat_events_conversation_ts
      ON events(conversation_id, timestamp, _id);
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_chat_events_request
      ON events(conversation_id, request_id);
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        conversation_id TEXT PRIMARY KEY,
        local_message_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  private withTransaction(work: () => void) {
    this.db.exec('BEGIN TRANSACTION;')
    try {
      work()
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
  }

  private transcriptFilePath(conversationId: string) {
    return path.join(this.transcriptsDir, `${fileSafeId(conversationId)}.jsonl`)
  }

  private upsertConversation(conversationId: string, updatedAt: number) {
    this.db.prepare(`
      INSERT INTO conversations (id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = CASE
          WHEN excluded.updated_at > updated_at THEN excluded.updated_at
          ELSE updated_at
        END
    `).run(conversationId, updatedAt)
  }

  private upsertEvent(conversationId: string, event: LocalChatEventRecord) {
    this.db.prepare(`
      INSERT INTO events (
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
    )
  }

  private trimConversationEvents(conversationId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE conversation_id = ?
    `).get(conversationId) as { count?: unknown } | undefined
    const total = typeof row?.count === 'number' ? row.count : 0
    const overflow = total - MAX_EVENTS_PER_CONVERSATION
    if (overflow <= 0) return

    this.db.prepare(`
      DELETE FROM events
      WHERE _id IN (
        SELECT _id
        FROM events
        WHERE conversation_id = ?
        ORDER BY timestamp ASC, _id ASC
        LIMIT ?
      )
    `).run(conversationId, overflow)
  }

  private deserializeEventRow(row: EventRow): LocalChatEventRecord {
    return {
      _id: row._id,
      timestamp: row.timestamp,
      type: row.type,
      ...(row.deviceId ? { deviceId: row.deviceId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
      ...(parseJsonRecord(row.payloadJson) ? { payload: parseJsonRecord(row.payloadJson) } : {}),
      ...(parseJsonRecord(row.channelEnvelopeJson)
        ? { channelEnvelope: parseJsonRecord(row.channelEnvelopeJson) }
        : {}),
    }
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
      FROM events
      WHERE conversation_id = ?
      ORDER BY timestamp ASC, _id ASC
    `).all(conversationId) as EventRow[]

    return rows.map((row) => this.deserializeEventRow(row))
  }

  private rebuildTranscriptFile(conversationId: string) {
    const filePath = this.transcriptFilePath(conversationId)
    const events = this.listAllEventsForConversation(conversationId)
    if (events.length === 0) {
      try {
        fs.unlinkSync(filePath)
      } catch {
        // Ignore missing transcript files.
      }
      return
    }

    const lines = events.map((event) =>
      JSON.stringify(toStoredEventRecord(conversationId, event)),
    )
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
  }

  private sanitizeConversationId(value: unknown) {
    const conversationId = asTrimmedString(value)
    if (!conversationId) {
      throw new Error('conversationId is required.')
    }
    return conversationId
  }

  private sanitizeAppendArgs(args: LocalChatAppendEventArgs): {
    conversationId: string
    event: LocalChatEventRecord
  } {
    const conversationId = this.sanitizeConversationId(args.conversationId)
    const type = asTrimmedString(args.type)
    if (!type) {
      throw new Error('type is required.')
    }

    const timestamp = asFiniteNumber(args.timestamp) ?? Date.now()
    const eventId = asTrimmedString(args.eventId) || `local-${generateLocalId()}`
    const payload = asObject(args.payload) ?? undefined
    const channelEnvelope = asObject(args.channelEnvelope) ?? undefined
    const deviceId = asTrimmedString(args.deviceId) || undefined
    const requestId = asTrimmedString(args.requestId) || undefined
    const targetDeviceId = asTrimmedString(args.targetDeviceId) || undefined

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
    }
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const { conversationId, event } = this.sanitizeAppendArgs(args)

    this.withTransaction(() => {
      this.upsertConversation(conversationId, event.timestamp)
      this.upsertEvent(conversationId, event)
      this.trimConversationEvents(conversationId)
    })

    this.rebuildTranscriptFile(conversationId)
    return event
  }

  listEvents(conversationIdInput: string, maxItems = 200): LocalChatEventRecord[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput)
    const normalizedLimit = Math.max(1, Math.floor(maxItems))
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
        FROM events
        WHERE conversation_id = ?
        ORDER BY timestamp DESC, _id DESC
        LIMIT ?
      ) recent
      ORDER BY timestamp ASC, _id ASC
    `).all(conversationId, normalizedLimit) as EventRow[]

    return rows.map((row) => this.deserializeEventRow(row))
  }

  getEventCount(conversationIdInput: string): number {
    const conversationId = this.sanitizeConversationId(conversationIdInput)
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE conversation_id = ?
    `).get(conversationId) as { count?: unknown } | undefined
    return typeof row?.count === 'number' ? row.count : 0
  }

  listSyncMessages(conversationIdInput: string, maxMessages = MAX_EVENTS_PER_CONVERSATION): LocalChatSyncMessage[] {
    const conversationId = this.sanitizeConversationId(conversationIdInput)
    const normalizedLimit = Math.max(1, Math.floor(maxMessages))
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
        FROM events
        WHERE conversation_id = ?
          AND type IN ('user_message', 'assistant_message')
        ORDER BY timestamp DESC, _id DESC
        LIMIT ?
      ) recent
      ORDER BY timestamp ASC, _id ASC
    `).all(conversationId, normalizedLimit) as Array<{
      _id: string
      timestamp: number
      type: string
      deviceId: string | null
      payloadJson: string | null
    }>

    const messages: LocalChatSyncMessage[] = []
    for (const row of rows) {
      const payload = parseJsonRecord(row.payloadJson)
      const text = eventTextFromPayload(payload)
      if (!text) continue

      const role = row.type === 'user_message' ? 'user' : 'assistant'
      messages.push({
        localMessageId: row._id,
        role,
        text,
        timestamp: row.timestamp,
        ...(role === 'user' && row.deviceId ? { deviceId: row.deviceId } : {}),
      })
    }

    return messages
  }

  getSyncCheckpoint(conversationIdInput: string): string | null {
    const conversationId = this.sanitizeConversationId(conversationIdInput)
    const row = this.db.prepare(`
      SELECT local_message_id AS localMessageId
      FROM sync_checkpoints
      WHERE conversation_id = ?
    `).get(conversationId) as { localMessageId?: unknown } | undefined
    return typeof row?.localMessageId === 'string' && row.localMessageId.length > 0
      ? row.localMessageId
      : null
  }

  setSyncCheckpoint(conversationIdInput: string, localMessageIdInput: string) {
    const conversationId = this.sanitizeConversationId(conversationIdInput)
    const localMessageId = asTrimmedString(localMessageIdInput)
    if (!localMessageId) return

    this.db.prepare(`
      INSERT INTO sync_checkpoints (conversation_id, local_message_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        local_message_id = excluded.local_message_id,
        updated_at = excluded.updated_at
    `).run(conversationId, localMessageId, Date.now())
  }

  importLegacyData(payload: ImportLegacyLocalChatPayload) {
    const store = payload.store
    const conversations = store?.conversations && typeof store.conversations === 'object'
      ? store.conversations
      : {}

    const updatedConversationIds = new Set<string>()
    let importedEvents = 0
    let importedCheckpoints = 0

    this.withTransaction(() => {
      for (const [conversationIdRaw, conversationValue] of Object.entries(conversations)) {
        const conversationId = asTrimmedString(conversationIdRaw)
        const conversation = asObject(conversationValue)
        if (!conversationId || !conversation) continue

        const events = Array.isArray(conversation.events)
          ? conversation.events
              .map((value) => sanitizeEventRecord(value))
              .filter((value): value is LocalChatEventRecord => value !== null)
              .sort((a, b) => {
                if (a.timestamp !== b.timestamp) {
                  return a.timestamp - b.timestamp
                }
                return a._id.localeCompare(b._id)
              })
              .slice(-MAX_EVENTS_PER_CONVERSATION)
          : []

        const updatedAt = asFiniteNumber(conversation.updatedAt)
          ?? events.at(-1)?.timestamp
          ?? Date.now()

        this.upsertConversation(conversationId, updatedAt)
        for (const event of events) {
          this.upsertEvent(conversationId, event)
          importedEvents += 1
        }
        this.trimConversationEvents(conversationId)
        updatedConversationIds.add(conversationId)
      }

      const checkpoints =
        payload.syncCheckpoints && typeof payload.syncCheckpoints === 'object'
          ? payload.syncCheckpoints
          : {}
      for (const [conversationIdRaw, localMessageIdRaw] of Object.entries(checkpoints)) {
        const conversationId = asTrimmedString(conversationIdRaw)
        const localMessageId = asTrimmedString(localMessageIdRaw)
        if (!conversationId || !localMessageId) continue
        this.db.prepare(`
          INSERT INTO sync_checkpoints (conversation_id, local_message_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            local_message_id = excluded.local_message_id,
            updated_at = excluded.updated_at
        `).run(conversationId, localMessageId, Date.now())
        importedCheckpoints += 1
      }
    })

    for (const conversationId of updatedConversationIds) {
      this.rebuildTranscriptFile(conversationId)
    }

    return {
      importedConversations: updatedConversationIds.size,
      importedEvents,
      importedCheckpoints,
    }
  }

  close() {
    this.db.close?.()
  }
}
