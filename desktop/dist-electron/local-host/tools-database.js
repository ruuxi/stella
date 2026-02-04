/**
 * Database tools: SqliteQuery handler.
 */
import { promises as fs } from "fs";
import { expandHomePath, truncate } from "./tools-utils.js";
export const openDatabase = async (dbPath) => {
    // Check if running in Bun
    if (typeof globalThis.Bun !== "undefined") {
        // @ts-expect-error bun:sqlite only available at runtime in Bun
        const { Database: BunDatabase } = await import("bun:sqlite");
        return new BunDatabase(dbPath, { readonly: true });
    }
    // Node.js / Electron
    const { default: Database } = await import("better-sqlite3");
    return new Database(dbPath, { readonly: true });
};
/**
 * SqliteQuery: Execute read-only SQL queries on SQLite databases.
 */
export const handleSqliteQuery = async (args, context) => {
    void context; // Unused but kept for interface consistency
    const dbPath = expandHomePath(String(args.database_path ?? ""));
    const query = String(args.query ?? "").trim();
    const limit = Math.min(Number(args.limit ?? 100), 500);
    if (!dbPath) {
        return { error: "database_path is required." };
    }
    if (!query) {
        return { error: "query is required." };
    }
    // Block non-SELECT queries for safety
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery.startsWith("select") && !normalizedQuery.startsWith("pragma")) {
        return { error: "Only SELECT and PRAGMA queries are allowed." };
    }
    // Verify database file exists
    try {
        await fs.access(dbPath);
    }
    catch {
        return { error: `Database not found: ${dbPath}` };
    }
    try {
        const db = await openDatabase(dbPath);
        // Add LIMIT if not present to prevent massive result sets
        let finalQuery = query;
        if (!normalizedQuery.includes(" limit ")) {
            finalQuery = `${query} LIMIT ${limit}`;
        }
        const stmt = db.prepare(finalQuery);
        const rows = stmt.all();
        db.close();
        if (rows.length === 0) {
            return { result: "Query returned no results." };
        }
        const json = JSON.stringify(rows, null, 2);
        return {
            result: `Query returned ${rows.length} row(s):\n\n${truncate(json, 20000)}`,
        };
    }
    catch (error) {
        return { error: `SQLite error: ${error.message}` };
    }
};
