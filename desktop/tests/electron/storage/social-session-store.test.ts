import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite");

  class BunSqliteMock {
    private readonly db: InstanceType<typeof DatabaseSync>;

    constructor(filePath: string, options?: { readonly?: boolean }) {
      this.db = new DatabaseSync(filePath, {
        readOnly: options?.readonly === true,
      });
    }

    exec(sql: string) {
      this.db.exec(sql);
    }

    prepare(sql: string) {
      return this.db.prepare(sql);
    }

    close() {
      this.db.close();
    }
  }

  return { Database: BunSqliteMock };
});

import { createDesktopDatabase } from "../../../packages/runtime-kernel/storage/database.js";
import { SocialSessionStore } from "../../../packages/runtime-worker/social-sessions/store.js";

const tempHomes: string[] = [];
const openDatabases = new Set<{ close(): void }>();

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-social-session-store-"));
  tempHomes.push(dir);
  return dir;
};

afterEach(() => {
  for (const db of openDatabases) {
    db.close();
  }
  openDatabases.clear();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("SocialSessionStore", () => {
  it("persists sync state and tracked file hashes across restarts", () => {
    const stellaHome = createTempHome();
    const db = createDesktopDatabase(stellaHome);
    openDatabases.add(db);
    const store = new SocialSessionStore(db);

    store.upsertSession({
      sessionId: "session-1",
      localFolderPath: "C:/workspace/social-sessions/session-1",
      localFolderName: "Session 1",
      role: "host",
      lastAppliedFileOpOrdinal: 3,
      lastObservedTurnOrdinal: 5,
    });
    store.upsertFile({
      sessionId: "session-1",
      relativePath: "src/app.ts",
      contentHash: "abc123",
      sizeBytes: 42,
      mtimeMs: 100,
    });

    db.close();
    openDatabases.delete(db);

    const reopenedDb = createDesktopDatabase(stellaHome);
    openDatabases.add(reopenedDb);
    const reopenedStore = new SocialSessionStore(reopenedDb);

    expect(reopenedStore.getSession("session-1")).toMatchObject({
      sessionId: "session-1",
      role: "host",
      lastAppliedFileOpOrdinal: 3,
      lastObservedTurnOrdinal: 5,
    });
    expect(reopenedStore.listFiles("session-1")).toEqual([
      expect.objectContaining({
        relativePath: "src/app.ts",
        contentHash: "abc123",
        sizeBytes: 42,
      }),
    ]);
  });
});

