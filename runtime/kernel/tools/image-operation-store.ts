import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ManagedImageTerminalResult } from "./managed-image-job.js";

const DATABASE_FILE = "image-tool-operations.sqlite";

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const hashImageOperationRequest = (
  requestBody: Record<string, unknown>,
): string =>
  createHash("sha256")
    .update("stella-image-operation-v1\0")
    .update(stableJson(requestBody))
    .digest("hex");

type OperationRow = {
  operation_id: string;
  job_id: string | null;
  state: "pending" | "succeeded" | "failed" | "canceled";
  submission_state: "pending" | "dispatching" | "submitted" | null;
  terminal_result_json: string | null;
  delivered_at: number | null;
  request_hash?: string;
  alias_request_hash?: string | null;
  alias_identity_version?: number | null;
};

export type DurableImageOperation = {
  operationId: string;
  jobId?: string;
  terminalResult?: ManagedImageTerminalResult;
  reattached: boolean;
  submissionState: "pending" | "dispatching" | "submitted";
};

const tableColumns = (db: DatabaseSync, table: string): Set<string> =>
  new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );

const openDatabase = (stellaDataDir: string): DatabaseSync => {
  fs.mkdirSync(stellaDataDir, { recursive: true });
  const db = new DatabaseSync(path.join(stellaDataDir, DATABASE_FILE), {
    timeout: 5_000,
  });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_tool_operations (
      operation_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      job_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed','canceled')),
      terminal_result_json TEXT,
      delivered_at INTEGER,
      submission_state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_tool_operations_request
      ON image_tool_operations(conversation_id, request_hash, updated_at DESC);
    CREATE TABLE IF NOT EXISTS image_tool_operation_aliases (
      conversation_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_hash TEXT,
      identity_version INTEGER NOT NULL DEFAULT 2,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, tool_call_id),
      FOREIGN KEY (operation_id) REFERENCES image_tool_operations(operation_id)
    );
  `);
  const operationColumns = tableColumns(db, "image_tool_operations");
  if (!operationColumns.has("submission_state")) {
    db.exec(
      "ALTER TABLE image_tool_operations ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'pending'",
    );
  }
  const aliasColumns = tableColumns(db, "image_tool_operation_aliases");
  if (!aliasColumns.has("request_hash")) {
    db.exec(
      "ALTER TABLE image_tool_operation_aliases ADD COLUMN request_hash TEXT",
    );
  }
  if (!aliasColumns.has("identity_version")) {
    // Rows from releases before canonical external-engine identities are
    // eligible for exactly one request-hash migration reattachment.
    db.exec(
      "ALTER TABLE image_tool_operation_aliases ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1",
    );
  }
  db.exec(`
    UPDATE image_tool_operation_aliases
    SET request_hash = (
      SELECT request_hash FROM image_tool_operations o
      WHERE o.operation_id = image_tool_operation_aliases.operation_id
    )
    WHERE request_hash IS NULL;
  `);
  return db;
};

const toOperation = (
  row: OperationRow,
  reattached: boolean,
): DurableImageOperation => ({
  operationId: row.operation_id,
  ...(row.job_id ? { jobId: row.job_id } : {}),
  ...(row.terminal_result_json
    ? (() => {
        const terminal = JSON.parse(
          row.terminal_result_json,
        ) as ManagedImageTerminalResult;
        return { terminalResult: { ...terminal, reattached: true } };
      })()
    : {}),
  reattached,
  submissionState: row.submission_state ?? "pending",
});

export const reserveDurableImageOperation = (args: {
  stellaDataDir: string;
  conversationId: string;
  toolCallId: string;
  requestBody: Record<string, unknown>;
}): DurableImageOperation => {
  const db = openDatabase(args.stellaDataDir);
  const requestHash = hashImageOperationRequest(args.requestBody);
  const now = Date.now();
  try {
    db.exec("BEGIN IMMEDIATE");
    const alias = db
      .prepare(
        `SELECT o.operation_id, o.job_id, o.state, o.submission_state,
                o.terminal_result_json, o.delivered_at,
                o.request_hash, a.request_hash AS alias_request_hash,
                a.identity_version AS alias_identity_version
         FROM image_tool_operation_aliases a
         JOIN image_tool_operations o ON o.operation_id = a.operation_id
         WHERE a.conversation_id = ? AND a.tool_call_id = ?`,
      )
      .get(args.conversationId, args.toolCallId) as OperationRow | undefined;
    if (
      alias &&
      alias.request_hash === requestHash &&
      alias.alias_request_hash === requestHash &&
      (alias.state === "pending" || alias.delivered_at === null)
    ) {
      db.exec("COMMIT");
      return toOperation(alias, true);
    }

    // Pre-canonical external-engine aliases get one migration reattachment by
    // request hash. Current aliases never use this fallback: a different
    // canonical tool-call identity is an intentional new invocation, even if
    // its arguments happen to be identical.
    const recoverable = db
      .prepare(
        `SELECT operation_id, job_id, state, submission_state,
                terminal_result_json, delivered_at, request_hash
         FROM image_tool_operations o
         WHERE o.conversation_id = ? AND o.request_hash = ?
           AND (o.state = 'pending' OR o.delivered_at IS NULL)
           AND EXISTS (
             SELECT 1 FROM image_tool_operation_aliases legacy
             WHERE legacy.operation_id = o.operation_id
               AND legacy.identity_version = 1
           )
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(args.conversationId, requestHash) as OperationRow | undefined;
    const operationId = recoverable?.operation_id ?? randomUUID();
    if (!recoverable) {
      db.prepare(
        `INSERT INTO image_tool_operations
         (operation_id, conversation_id, request_hash, state, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(operationId, args.conversationId, requestHash, now, now);
    } else {
      db.prepare(
        `UPDATE image_tool_operation_aliases SET identity_version = 2
         WHERE operation_id = ?`,
      ).run(operationId);
    }
    db.prepare(
      `INSERT INTO image_tool_operation_aliases
       (conversation_id, tool_call_id, operation_id, request_hash, identity_version, created_at)
       VALUES (?, ?, ?, ?, 2, ?)
       ON CONFLICT(conversation_id, tool_call_id) DO UPDATE SET
         operation_id = excluded.operation_id,
         request_hash = excluded.request_hash,
         identity_version = excluded.identity_version,
         created_at = excluded.created_at`,
    ).run(args.conversationId, args.toolCallId, operationId, requestHash, now);
    db.exec("COMMIT");
    return recoverable
      ? toOperation(recoverable, true)
      : {
          operationId,
          reattached: false,
          submissionState: "pending",
        };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may have failed before BEGIN completed.
    }
    throw error;
  } finally {
    db.close();
  }
};

/**
 * Durable local at-most-once boundary for BYOK providers. Once this CAS wins,
 * a restart may reattach a persisted provider request id, but it must never
 * blindly repeat an ambiguous direct POST.
 */
export const claimImageOperationSubmission = (args: {
  stellaDataDir: string;
  operationId: string;
}): boolean => {
  const db = openDatabase(args.stellaDataDir);
  try {
    const result = db
      .prepare(
        `UPDATE image_tool_operations
         SET submission_state = 'dispatching', updated_at = ?
         WHERE operation_id = ? AND state = 'pending'
           AND submission_state = 'pending'`,
      )
      .run(Date.now(), args.operationId);
    return result.changes === 1;
  } finally {
    db.close();
  }
};

export const markImageOperationSubmitted = (args: {
  stellaDataDir: string;
  operationId: string;
  providerRequestId?: string;
}): void => {
  const db = openDatabase(args.stellaDataDir);
  try {
    db.prepare(
      `UPDATE image_tool_operations
       SET submission_state = 'submitted', job_id = COALESCE(?, job_id),
           updated_at = ?
       WHERE operation_id = ? AND state = 'pending'
         AND submission_state = 'dispatching'`,
    ).run(args.providerRequestId ?? null, Date.now(), args.operationId);
  } finally {
    db.close();
  }
};

export const attachImageOperationJob = (args: {
  stellaDataDir: string;
  operationId: string;
  jobId: string;
}): void => {
  const db = openDatabase(args.stellaDataDir);
  try {
    db.prepare(
      `UPDATE image_tool_operations SET job_id = ?, updated_at = ?
       WHERE operation_id = ? AND state = 'pending'`,
    ).run(args.jobId, Date.now(), args.operationId);
  } finally {
    db.close();
  }
};

export const settleImageOperation = (args: {
  stellaDataDir: string;
  operationId: string;
  result: ManagedImageTerminalResult;
}): void => {
  const db = openDatabase(args.stellaDataDir);
  const state = args.result.ok
    ? "succeeded"
    : args.result.status === "unknown"
      ? "failed"
      : args.result.status;
  try {
    db.prepare(
      `UPDATE image_tool_operations
       SET state = ?, job_id = COALESCE(job_id, ?), terminal_result_json = ?, updated_at = ?
       WHERE operation_id = ? AND state = 'pending'`,
    ).run(
      state,
      args.result.ok ? args.result.job.jobId : (args.result.jobId ?? null),
      JSON.stringify(args.result),
      Date.now(),
      args.operationId,
    );
  } finally {
    db.close();
  }
};

export const markImageOperationDelivered = (args: {
  stellaDataDir?: string;
  conversationId: string;
  toolCallId: string;
}): void => {
  if (!args.stellaDataDir) return;
  const db = openDatabase(args.stellaDataDir);
  try {
    db.prepare(
      `UPDATE image_tool_operations SET delivered_at = ?, updated_at = ?
       WHERE operation_id = (
         SELECT operation_id FROM image_tool_operation_aliases
         WHERE conversation_id = ? AND tool_call_id = ?
       ) AND state != 'pending'`,
    ).run(Date.now(), Date.now(), args.conversationId, args.toolCallId);
  } finally {
    db.close();
  }
};

export const pruneImageOperationLedger = (args: {
  stellaDataDir: string;
  deliveredBefore?: number;
  limit?: number;
}): number => {
  const db = openDatabase(args.stellaDataDir);
  const deliveredBefore =
    args.deliveredBefore ?? Date.now() - 30 * 24 * 60 * 60_000;
  const limit = Math.max(1, Math.min(args.limit ?? 500, 2_000));
  try {
    db.exec("BEGIN IMMEDIATE");
    const rows = db
      .prepare(
        `SELECT operation_id FROM image_tool_operations
         WHERE state != 'pending' AND delivered_at IS NOT NULL
           AND delivered_at < ?
         ORDER BY delivered_at ASC LIMIT ?`,
      )
      .all(deliveredBefore, limit) as Array<{ operation_id: string }>;
    const removeAliases = db.prepare(
      "DELETE FROM image_tool_operation_aliases WHERE operation_id = ?",
    );
    const removeOperation = db.prepare(
      "DELETE FROM image_tool_operations WHERE operation_id = ?",
    );
    for (const row of rows) {
      removeAliases.run(row.operation_id);
      removeOperation.run(row.operation_id);
    }
    db.exec("COMMIT");
    return rows.length;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Transaction may not have started.
    }
    throw error;
  } finally {
    db.close();
  }
};
