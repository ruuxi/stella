/**
 * Database tools: SqliteQuery handler.
 */
import type { ToolContext, ToolResult } from "./tools-types.js";
type SqliteDatabase = {
    prepare(sql: string): {
        all(): unknown[];
    };
    close(): void;
};
export declare const openDatabase: (dbPath: string) => Promise<SqliteDatabase>;
/**
 * SqliteQuery: Execute read-only SQL queries on SQLite databases.
 */
export declare const handleSqliteQuery: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
export {};
