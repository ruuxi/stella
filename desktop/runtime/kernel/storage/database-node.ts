import { DatabaseSync } from "node:sqlite";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "./database-init.js";
import type { SqliteDatabase } from "./shared.js";

const openDatabase = (dbPath: string): SqliteDatabase =>
  new DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SqliteDatabase;

export const createDesktopDatabase = (stellaHome: string): SqliteDatabase => {
  const db = openDatabase(getDesktopDatabasePath(stellaHome));
  initializeDesktopDatabase(db);
  return db;
};
