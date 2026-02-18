/**
 * SQLite database connection and helpers for local-first storage.
 * All user data lives in ~/.stella/data/stella.db.
 */
import Database from "better-sqlite3";
/** Generate a new ULID (time-sortable, globally unique) */
export declare function newId(): string;
/** Get or create the database connection */
export declare function getDb(): Database.Database;
/** Close the database connection (call on app quit) */
export declare function closeDb(): void;
export interface QueryOptions {
    where?: Record<string, unknown>;
    orderBy?: string;
    order?: "ASC" | "DESC";
    limit?: number;
    offset?: number;
}
/** Insert a row and return its id */
export declare function insert(table: string, data: Record<string, unknown>): string;
/** Update rows matching conditions */
export declare function update(table: string, data: Record<string, unknown>, where: Record<string, unknown>): number;
/** Delete rows matching conditions */
export declare function remove(table: string, where: Record<string, unknown>): number;
/** Find one row by id */
export declare function findById<T = Record<string, unknown>>(table: string, id: string): T | undefined;
/** Query rows with options */
export declare function query<T = Record<string, unknown>>(table: string, opts?: QueryOptions): T[];
/** Run a raw SQL query */
export declare function rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
/** Run a raw SQL statement (INSERT/UPDATE/DELETE) */
export declare function rawRun(sql: string, params?: unknown[]): Database.RunResult;
/** Wrap operations in a transaction */
export declare function transaction<T>(fn: () => T): T;
