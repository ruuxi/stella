/**
 * Versioned SQLite migrations for local-first storage.
 * Each migration is run once and tracked in the _migrations table.
 */
import type Database from "better-sqlite3";
/**
 * Run all pending migrations in order.
 * Each migration runs inside a transaction.
 */
export declare function runMigrations(db: Database.Database): void;
