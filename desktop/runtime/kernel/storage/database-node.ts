import BetterSqliteDatabase from "better-sqlite3";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "./database-init.js";
import type { SqliteDatabase } from "./shared.js";

const openDatabase = (dbPath: string): SqliteDatabase =>
  new BetterSqliteDatabase(dbPath) as unknown as SqliteDatabase;

export const createDesktopDatabase = (stellaHome: string): SqliteDatabase => {
  const db = openDatabase(getDesktopDatabasePath(stellaHome));
  initializeDesktopDatabase(db);
  return db;
};
