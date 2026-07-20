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
  terminal_result_json: string | null;
  delivered_at: number | null;
};

export type DurableImageOperation = {
  operationId: string;
  jobId?: string;
  terminalResult?: ManagedImageTerminalResult;
  reattached: boolean;
};

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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_tool_operations_request
      ON image_tool_operations(conversation_id, request_hash, updated_at DESC);
    CREATE TABLE IF NOT EXISTS image_tool_operation_aliases (
      conversation_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, tool_call_id),
      FOREIGN KEY (operation_id) REFERENCES image_tool_operations(operation_id)
    );
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
        `SELECT o.operation_id, o.job_id, o.state, o.terminal_result_json, o.delivered_at
         FROM image_tool_operation_aliases a
         JOIN image_tool_operations o ON o.operation_id = a.operation_id
         WHERE a.conversation_id = ? AND a.tool_call_id = ?`,
      )
      .get(args.conversationId, args.toolCallId) as OperationRow | undefined;
    if (alias) {
      db.exec("COMMIT");
      return toOperation(alias, true);
    }

    // A restarted external engine may assign a fresh process-local call id.
    // Reattach only work still pending or a terminal result not yet persisted
    // into Stella's transcript. Delivered terminal calls are new invocations.
    const recoverable = db
      .prepare(
        `SELECT operation_id, job_id, state, terminal_result_json, delivered_at
         FROM image_tool_operations
         WHERE conversation_id = ? AND request_hash = ?
           AND (state = 'pending' OR delivered_at IS NULL)
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
    }
    db.prepare(
      `INSERT INTO image_tool_operation_aliases
       (conversation_id, tool_call_id, operation_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(args.conversationId, args.toolCallId, operationId, now);
    db.exec("COMMIT");
    return recoverable
      ? toOperation(recoverable, true)
      : { operationId, reattached: false };
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
  const state = args.result.ok ? "succeeded" : args.result.status;
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
