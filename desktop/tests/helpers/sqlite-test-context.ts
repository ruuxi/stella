import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../runtime/kernel/storage/shared.js";

export type SqliteTestContext<TStore> = {
  rootPath: string;
  db: SqliteDatabase;
  store: TStore;
};

export function createSqliteTestContextFactory<TStore>(
  prefix: string,
  createStore: (db: SqliteDatabase) => TStore,
) {
  const activeContexts = new Set<SqliteTestContext<TStore>>();

  return {
    create(): SqliteTestContext<TStore> {
      const rootPath = path.join(
        os.tmpdir(),
        `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const dbPath = getDesktopDatabasePath(rootPath);
      const db = new DatabaseSync(dbPath, {
        timeout: 5_000,
      }) as unknown as SqliteDatabase;
      initializeDesktopDatabase(db);
      const context = {
        rootPath,
        db,
        store: createStore(db),
      };
      activeContexts.add(context);
      return context;
    },
    async cleanup() {
      for (const context of activeContexts) {
        context.db.close();
        await rm(context.rootPath, { recursive: true, force: true });
      }
      activeContexts.clear();
    },
  };
}
