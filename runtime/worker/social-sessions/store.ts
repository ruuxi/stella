import type { SqliteDatabase } from "../../kernel/storage/shared.js";

export type SocialSessionRole = "host" | "follower";

export type SocialSessionSyncRecord = {
  sessionId: string;
  localFolderPath: string;
  localFolderName: string;
  role: SocialSessionRole;
  lastAppliedFileOpOrdinal: number;
  lastObservedTurnOrdinal: number;
  updatedAt: number;
};

export type SocialSessionFileRecord = {
  sessionId: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  updatedAt: number;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export class SocialSessionStore {
  constructor(private readonly db: SqliteDatabase) {}

  listSessions(): SocialSessionSyncRecord[] {
    const rows = this.db
      .prepare(`
      SELECT
        session_id AS sessionId,
        local_folder_path AS localFolderPath,
        local_folder_name AS localFolderName,
        role,
        last_applied_file_op_ordinal AS lastAppliedFileOpOrdinal,
        last_observed_turn_ordinal AS lastObservedTurnOrdinal,
        updated_at AS updatedAt
      FROM social_session_sync_state
      ORDER BY updated_at DESC
    `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: asString(row.sessionId),
      localFolderPath: asString(row.localFolderPath),
      localFolderName: asString(row.localFolderName),
      role: asString(row.role) === "host" ? "host" : "follower",
      lastAppliedFileOpOrdinal: asNumber(row.lastAppliedFileOpOrdinal),
      lastObservedTurnOrdinal: asNumber(row.lastObservedTurnOrdinal),
      updatedAt: asNumber(row.updatedAt),
    }));
  }

  getSession(sessionId: string): SocialSessionSyncRecord | null {
    const row = this.db
      .prepare(`
      SELECT
        session_id AS sessionId,
        local_folder_path AS localFolderPath,
        local_folder_name AS localFolderName,
        role,
        last_applied_file_op_ordinal AS lastAppliedFileOpOrdinal,
        last_observed_turn_ordinal AS lastObservedTurnOrdinal,
        updated_at AS updatedAt
      FROM social_session_sync_state
      WHERE session_id = ?
    `)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      sessionId: asString(row.sessionId),
      localFolderPath: asString(row.localFolderPath),
      localFolderName: asString(row.localFolderName),
      role: asString(row.role) === "host" ? "host" : "follower",
      lastAppliedFileOpOrdinal: asNumber(row.lastAppliedFileOpOrdinal),
      lastObservedTurnOrdinal: asNumber(row.lastObservedTurnOrdinal),
      updatedAt: asNumber(row.updatedAt),
    };
  }

  upsertSession(
    record: Omit<SocialSessionSyncRecord, "updatedAt"> & { updatedAt?: number },
  ): SocialSessionSyncRecord {
    const updatedAt = record.updatedAt ?? Date.now();
    this.db
      .prepare(`
      INSERT INTO social_session_sync_state (
        session_id,
        local_folder_path,
        local_folder_name,
        role,
        last_applied_file_op_ordinal,
        last_observed_turn_ordinal,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        local_folder_path = excluded.local_folder_path,
        local_folder_name = excluded.local_folder_name,
        role = excluded.role,
        last_applied_file_op_ordinal = excluded.last_applied_file_op_ordinal,
        last_observed_turn_ordinal = excluded.last_observed_turn_ordinal,
        updated_at = excluded.updated_at
    `)
      .run(
        record.sessionId,
        record.localFolderPath,
        record.localFolderName,
        record.role,
        record.lastAppliedFileOpOrdinal,
        record.lastObservedTurnOrdinal,
        updatedAt,
      );
    return {
      ...record,
      updatedAt,
    };
  }

  patchSession(
    sessionId: string,
    patch: Partial<
      Pick<
        SocialSessionSyncRecord,
        | "localFolderPath"
        | "localFolderName"
        | "role"
        | "lastAppliedFileOpOrdinal"
        | "lastObservedTurnOrdinal"
      >
    >,
  ): SocialSessionSyncRecord | null {
    const existing = this.getSession(sessionId);
    if (!existing) {
      return null;
    }
    return this.upsertSession({
      sessionId,
      localFolderPath: patch.localFolderPath ?? existing.localFolderPath,
      localFolderName: patch.localFolderName ?? existing.localFolderName,
      role: patch.role ?? existing.role,
      lastAppliedFileOpOrdinal:
        patch.lastAppliedFileOpOrdinal ?? existing.lastAppliedFileOpOrdinal,
      lastObservedTurnOrdinal:
        patch.lastObservedTurnOrdinal ?? existing.lastObservedTurnOrdinal,
    });
  }

  removeSession(sessionId: string): void {
    this.db.prepare("DELETE FROM social_session_files WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM social_session_sync_state WHERE session_id = ?").run(sessionId);
  }

  listFiles(sessionId: string): SocialSessionFileRecord[] {
    const rows = this.db
      .prepare(`
      SELECT
        session_id AS sessionId,
        relative_path AS relativePath,
        content_hash AS contentHash,
        size_bytes AS sizeBytes,
        mtime_ms AS mtimeMs,
        updated_at AS updatedAt
      FROM social_session_files
      WHERE session_id = ?
      ORDER BY relative_path ASC
    `)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: asString(row.sessionId),
      relativePath: asString(row.relativePath),
      contentHash: asString(row.contentHash),
      sizeBytes: asNumber(row.sizeBytes),
      mtimeMs: asNumber(row.mtimeMs),
      updatedAt: asNumber(row.updatedAt),
    }));
  }

  upsertFile(
    record: Omit<SocialSessionFileRecord, "updatedAt"> & { updatedAt?: number },
  ): SocialSessionFileRecord {
    const updatedAt = record.updatedAt ?? Date.now();
    this.db
      .prepare(`
      INSERT INTO social_session_files (
        session_id,
        relative_path,
        content_hash,
        size_bytes,
        mtime_ms,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, relative_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at
    `)
      .run(
        record.sessionId,
        record.relativePath,
        record.contentHash,
        record.sizeBytes,
        record.mtimeMs,
        updatedAt,
      );
    return {
      ...record,
      updatedAt,
    };
  }

  removeFile(sessionId: string, relativePath: string): void {
    this.db
      .prepare(`
      DELETE FROM social_session_files
      WHERE session_id = ?
        AND relative_path = ?
    `)
      .run(sessionId, relativePath);
  }
}
