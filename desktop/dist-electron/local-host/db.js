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
let db = null;
/** Generate a new ULID (time-sortable, globally unique) */
export function newId() {
    return ulid();
}
/** Get or create the database connection */
export function getDb() {
    if (db)
        return db;
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
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
/** Insert a row and return its id */
export function insert(table, data) {
    const d = getDb();
    const id = data.id || newId();
    const row = { ...data, id };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
    d.prepare(sql).run(...cols.map((c) => serializeValue(row[c])));
    return id;
}
/** Update rows matching conditions */
export function update(table, data, where) {
    const d = getDb();
    const setCols = Object.keys(data);
    const setClause = setCols.map((c) => `${c} = ?`).join(", ");
    const whereCols = Object.keys(where);
    const whereClause = whereCols.map((c) => `${c} = ?`).join(" AND ");
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const result = d.prepare(sql).run(...setCols.map((c) => serializeValue(data[c])), ...whereCols.map((c) => serializeValue(where[c])));
    return result.changes;
}
/** Delete rows matching conditions */
export function remove(table, where) {
    const d = getDb();
    const whereCols = Object.keys(where);
    const whereClause = whereCols.map((c) => `${c} = ?`).join(" AND ");
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
    const result = d.prepare(sql).run(...whereCols.map((c) => serializeValue(where[c])));
    return result.changes;
}
/** Find one row by id */
export function findById(table, id) {
    const d = getDb();
    const row = d.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return row ? deserializeRow(row) : undefined;
}
/** Query rows with options */
export function query(table, opts = {}) {
    const d = getDb();
    let sql = `SELECT * FROM ${table}`;
    const params = [];
    if (opts.where && Object.keys(opts.where).length > 0) {
        const whereCols = Object.keys(opts.where);
        sql += " WHERE " + whereCols.map((c) => `${c} = ?`).join(" AND ");
        params.push(...whereCols.map((c) => serializeValue(opts.where[c])));
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
    const rows = d.prepare(sql).all(...params);
    return rows.map((r) => deserializeRow(r));
}
/** Run a raw SQL query */
export function rawQuery(sql, params = []) {
    const d = getDb();
    const rows = d.prepare(sql).all(...params);
    return rows.map((r) => deserializeRow(r));
}
/** Run a raw SQL statement (INSERT/UPDATE/DELETE) */
export function rawRun(sql, params = []) {
    const d = getDb();
    return d.prepare(sql).run(...params);
}
/** Wrap operations in a transaction */
export function transaction(fn) {
    const d = getDb();
    return d.transaction(fn)();
}
// ─── Serialization ──────────────────────────────────────────────────────────
/** Serialize a JS value for SQLite storage (objects/arrays → JSON strings, booleans → integers) */
function serializeValue(val) {
    if (val === undefined || val === null)
        return null;
    if (typeof val === "boolean")
        return val ? 1 : 0;
    if (typeof val === "object")
        return JSON.stringify(val);
    return val;
}
/** Deserialize a row from SQLite (try to parse JSON strings back to objects) */
function deserializeRow(row) {
    const result = {};
    for (const [key, val] of Object.entries(row)) {
        if (typeof val === "string" && (val.startsWith("{") || val.startsWith("["))) {
            try {
                result[key] = JSON.parse(val);
            }
            catch {
                result[key] = val;
            }
        }
        else {
            result[key] = val;
        }
    }
    return result;
}
