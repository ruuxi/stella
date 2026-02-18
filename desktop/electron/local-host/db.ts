/**
 * SQLite database connection and helpers for local-first storage.
 * All user data lives in ~/.stella/data/stella.db.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ulid } from "ulid";
import os from "os";
import { runMigrations } from "./db_migrations";

let db: Database.Database | null = null;

/** Generate a new ULID (time-sortable, globally unique) */
export function newId(): string {
  return ulid();
}

/** Get or create the database connection */
export function getDb(): Database.Database {
  if (db) return db;

  const stellaHome = path.join(os.homedir(), ".stella");
  const dataDir = path.join(stellaHome, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "stella.db");
  db = new Database(dbPath);

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Run migrations
  runMigrations(db);

  return db;
}

/** Close the database connection (call on app quit) */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Generic CRUD Helpers ────────────────────────────────────────────────────

export interface QueryOptions {
  where?: Record<string, unknown>;
  orderBy?: string;
  order?: "ASC" | "DESC";
  limit?: number;
  offset?: number;
}

/** Insert a row and return its id */
export function insert(
  table: string,
  data: Record<string, unknown>,
): string {
  const d = getDb();
  const id = data.id as string || newId();
  const row = { ...data, id };

  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
  d.prepare(sql).run(...cols.map((c) => serializeValue(row[c])));
  return id;
}

/** Update rows matching conditions */
export function update(
  table: string,
  data: Record<string, unknown>,
  where: Record<string, unknown>,
): number {
  const d = getDb();
  const setCols = Object.keys(data);
  const setClause = setCols.map((c) => `${c} = ?`).join(", ");
  const whereCols = Object.keys(where);
  const whereClause = whereCols.map((c) => `${c} = ?`).join(" AND ");

  const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
  const result = d.prepare(sql).run(
    ...setCols.map((c) => serializeValue(data[c])),
    ...whereCols.map((c) => serializeValue(where[c])),
  );
  return result.changes;
}

/** Delete rows matching conditions */
export function remove(
  table: string,
  where: Record<string, unknown>,
): number {
  const d = getDb();
  const whereCols = Object.keys(where);
  const whereClause = whereCols.map((c) => `${c} = ?`).join(" AND ");
  const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
  const result = d.prepare(sql).run(
    ...whereCols.map((c) => serializeValue(where[c])),
  );
  return result.changes;
}

/** Find one row by id */
export function findById<T = Record<string, unknown>>(
  table: string,
  id: string,
): T | undefined {
  const d = getDb();
  const row = d.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as T | undefined;
  return row ? deserializeRow(row as Record<string, unknown>) as T : undefined;
}

/** Query rows with options */
export function query<T = Record<string, unknown>>(
  table: string,
  opts: QueryOptions = {},
): T[] {
  const d = getDb();
  let sql = `SELECT * FROM ${table}`;
  const params: unknown[] = [];

  if (opts.where && Object.keys(opts.where).length > 0) {
    const whereCols = Object.keys(opts.where);
    sql += " WHERE " + whereCols.map((c) => `${c} = ?`).join(" AND ");
    params.push(...whereCols.map((c) => serializeValue(opts.where![c])));
  }

  if (opts.orderBy) {
    sql += ` ORDER BY ${opts.orderBy} ${opts.order || "ASC"}`;
  }

  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  if (opts.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(opts.offset);
  }

  const rows = d.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => deserializeRow(r) as T);
}

/** Run a raw SQL query */
export function rawQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T[] {
  const d = getDb();
  const rows = d.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => deserializeRow(r) as T);
}

/** Run a raw SQL statement (INSERT/UPDATE/DELETE) */
export function rawRun(
  sql: string,
  params: unknown[] = [],
): Database.RunResult {
  const d = getDb();
  return d.prepare(sql).run(...params);
}

/** Wrap operations in a transaction */
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  return d.transaction(fn)();
}

// ─── Serialization ──────────────────────────────────────────────────────────

/** Serialize a JS value for SQLite storage (objects/arrays → JSON strings, booleans → integers) */
function serializeValue(val: unknown): unknown {
  if (val === undefined || val === null) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "object") return JSON.stringify(val);
  return val;
}

/** Deserialize a row from SQLite (try to parse JSON strings back to objects) */
function deserializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === "string" && (val.startsWith("{") || val.startsWith("["))) {
      try {
        result[key] = JSON.parse(val);
      } catch {
        result[key] = val;
      }
    } else {
      result[key] = val;
    }
  }
  return result;
}
