import { Database } from "bun:sqlite";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "./database-init.js";
import type { SqliteDatabase } from "./shared.js";

const openDatabase = (dbPath: string): SqliteDatabase =>
  new Database(dbPath) as unknown as SqliteDatabase;

export const createDesktopDatabase = (stellaDataDir: string): SqliteDatabase => {
  const db = openDatabase(getDesktopDatabasePath(stellaDataDir));
  initializeDesktopDatabase(db);
  return db;
};
