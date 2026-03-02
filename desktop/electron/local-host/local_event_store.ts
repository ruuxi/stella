/**
 * Local Event Store — SQLite-based event storage for conversations.
 *
 * Replaces the localStorage-based local-chat-store with a more robust
 * SQLite store that supports larger conversations and survives localStorage limits.
 * Both cloud and local storage modes write locally first.
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import path from "path";
import fs from "fs";

// ── Schema ────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  device_id TEXT,
  request_id TEXT,
  target_device_id TEXT,
  payload_json TEXT,
  synced INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_conversation_timestamp
  ON events(conversation_id, timestamp ASC);

CREATE INDEX IF NOT EXISTS idx_events_unsynced
  ON events(synced, conversation_id) WHERE synced = 0;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
`;

// ── Types ─────────────────────────────────────────────────────────────────

export type LocalEvent = {
  id: string;
  conversationId: string;
  type: string;
  timestamp: number;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
};

export type AppendEventArgs = {
  conversationId: string;
  type: string;
  payload?: unknown;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  timestamp?: number;
  eventId?: string;
};

// ── ULID generation ───────────────────────────────────────────────────────

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
import crypto from "crypto";

const encodeBase32 = (value: number, length: number): string => {
  let remaining = Math.floor(value);
  let output = "";
  for (let i = 0; i < length; i++) {
    output = ULID_ALPHABET[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
};

const generateLocalId = (): string => {
  const time = encodeBase32(Date.now(), 10);
  const bytes = crypto.randomBytes(10);
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    randomPart += ULID_ALPHABET[bytes[i % 10] % 32];
  }
  return `${time}${randomPart}`;
};

// ── LocalEventStore ───────────────────────────────────────────────────────

export class LocalEventStore {
  private db: BetterSqlite3.Database;

  private stmtInsertEvent: BetterSqlite3.Statement;
  private stmtListEvents: BetterSqlite3.Statement;
  private stmtListUnsynced: BetterSqlite3.Statement;
  private stmtMarkSynced: BetterSqlite3.Statement;
  private stmtUpsertConversation: BetterSqlite3.Statement;

  constructor(stellaHome: string) {
    const stateDir = path.join(stellaHome, "state");
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const dbPath = path.join(stateDir, "event_store.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_SQL);

    this.stmtInsertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (id, conversation_id, type, timestamp, device_id, request_id, target_device_id, payload_json, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtListEvents = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, type, timestamp,
             device_id AS deviceId, request_id AS requestId,
             target_device_id AS targetDeviceId, payload_json AS payloadJson
      FROM events WHERE conversation_id = ?
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `);

    this.stmtListUnsynced = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, type, timestamp,
             device_id AS deviceId, request_id AS requestId,
             target_device_id AS targetDeviceId, payload_json AS payloadJson
      FROM events WHERE synced = 0 AND conversation_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `);

    this.stmtMarkSynced = this.db.prepare(`
      UPDATE events SET synced = 1 WHERE id = ?
    `);

    this.stmtUpsertConversation = this.db.prepare(`
      INSERT INTO conversations (id, updated_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `);
  }

  appendEvent(args: AppendEventArgs): LocalEvent {
    const timestamp = args.timestamp ?? Date.now();
    const id = args.eventId ?? `local-${generateLocalId()}`;

    const payloadJson = args.payload && typeof args.payload === "object"
      ? JSON.stringify(args.payload)
      : null;

    this.stmtInsertEvent.run(
      id,
      args.conversationId,
      args.type,
      timestamp,
      args.deviceId ?? null,
      args.requestId ?? null,
      args.targetDeviceId ?? null,
      payloadJson,
      0, // not synced
    );

    this.stmtUpsertConversation.run(args.conversationId, timestamp);

    const event: LocalEvent = {
      id,
      conversationId: args.conversationId,
      type: args.type,
      timestamp,
    };
    if (args.deviceId) event.deviceId = args.deviceId;
    if (args.requestId) event.requestId = args.requestId;
    if (args.targetDeviceId) event.targetDeviceId = args.targetDeviceId;
    if (args.payload && typeof args.payload === "object") {
      event.payload = args.payload as Record<string, unknown>;
    }

    return event;
  }

  listEvents(conversationId: string, limit = 200): LocalEvent[] {
    const rows = this.stmtListEvents.all(conversationId, limit) as Array<{
      id: string;
      conversationId: string;
      type: string;
      timestamp: number;
      deviceId: string | null;
      requestId: string | null;
      targetDeviceId: string | null;
      payloadJson: string | null;
    }>;

    return rows.map((row) => {
      const event: LocalEvent = {
        id: row.id,
        conversationId: row.conversationId,
        type: row.type,
        timestamp: row.timestamp,
      };
      if (row.deviceId) event.deviceId = row.deviceId;
      if (row.requestId) event.requestId = row.requestId;
      if (row.targetDeviceId) event.targetDeviceId = row.targetDeviceId;
      if (row.payloadJson) {
        try {
          event.payload = JSON.parse(row.payloadJson);
        } catch {
          // Ignore malformed JSON
        }
      }
      return event;
    });
  }

  listUnsyncedEvents(conversationId: string, limit = 100): LocalEvent[] {
    const rows = this.stmtListUnsynced.all(conversationId, limit) as Array<{
      id: string;
      conversationId: string;
      type: string;
      timestamp: number;
      deviceId: string | null;
      requestId: string | null;
      targetDeviceId: string | null;
      payloadJson: string | null;
    }>;

    return rows.map((row) => {
      const event: LocalEvent = {
        id: row.id,
        conversationId: row.conversationId,
        type: row.type,
        timestamp: row.timestamp,
      };
      if (row.deviceId) event.deviceId = row.deviceId;
      if (row.requestId) event.requestId = row.requestId;
      if (row.targetDeviceId) event.targetDeviceId = row.targetDeviceId;
      if (row.payloadJson) {
        try {
          event.payload = JSON.parse(row.payloadJson);
        } catch {
          // Ignore malformed JSON
        }
      }
      return event;
    });
  }

  markSynced(eventId: string): void {
    this.stmtMarkSynced.run(eventId);
  }

  markManySynced(eventIds: string[]): void {
    const markMany = this.db.transaction(() => {
      for (const id of eventIds) {
        this.stmtMarkSynced.run(id);
      }
    });
    markMany();
  }

  /**
   * Ingest events from Convex (cloud sync source) into local store.
   * Marks them as already synced.
   */
  ingestCloudEvents(conversationId: string, events: LocalEvent[]): void {
    const ingest = this.db.transaction(() => {
      for (const event of events) {
        const payloadJson = event.payload ? JSON.stringify(event.payload) : null;
        this.stmtInsertEvent.run(
          event.id,
          conversationId,
          event.type,
          event.timestamp,
          event.deviceId ?? null,
          event.requestId ?? null,
          event.targetDeviceId ?? null,
          payloadJson,
          1, // already synced
        );
      }
      if (events.length > 0) {
        const latest = events[events.length - 1];
        this.stmtUpsertConversation.run(conversationId, latest.timestamp);
      }
    });
    ingest();
  }

  close(): void {
    this.db.close();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

const stores = new Map<string, LocalEventStore>();

export const getLocalEventStore = (stellaHome: string): LocalEventStore => {
  const existing = stores.get(stellaHome);
  if (existing) return existing;
  const store = new LocalEventStore(stellaHome);
  stores.set(stellaHome, store);
  return store;
};
