// Persistence for the renderer-generated per-agent progress summaries
// ("searching documentation for rate limits"): ring-buffer replace semantics
// per publish, newest-last reads capped per agent, so Recall can report what
// a running agent is doing right now.

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-progress-summaries-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = { rootPath, db, store: new SessionStore(db) };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

describe("agent progress summaries", () => {
  it("round-trips entries newest-last and caps reads per agent", () => {
    const { store } = createTestContext();
    store.replaceAgentProgressSummaries({
      "thr-1": [
        { text: "reading the repo layout", atMs: 1_000 },
        { text: "searching documentation for rate limits", atMs: 2_000 },
        { text: "drafting the fetch wrapper", atMs: 3_000 },
        { text: "writing retry tests", atMs: 4_000 },
      ],
    });

    expect(store.listAgentProgressSummaries("thr-1", 3)).toEqual([
      { text: "searching documentation for rate limits", atMs: 2_000 },
      { text: "drafting the fetch wrapper", atMs: 3_000 },
      { text: "writing retry tests", atMs: 4_000 },
    ]);
    expect(store.listAgentProgressSummaries("thr-unknown", 3)).toEqual([]);
  });

  it("replaces an agent's rows wholesale per publish and leaves absent agents untouched", () => {
    const { store } = createTestContext();
    store.replaceAgentProgressSummaries({
      "thr-1": [{ text: "old phrase", atMs: 1_000 }],
      "thr-2": [{ text: "sibling phrase", atMs: 1_500 }],
    });
    store.replaceAgentProgressSummaries({
      "thr-1": [{ text: "new phrase", atMs: 2_000 }],
    });

    expect(store.listAgentProgressSummaries("thr-1")).toEqual([
      { text: "new phrase", atMs: 2_000 },
    ]);
    // thr-2 was absent from the second publish; its rows survive.
    expect(store.listAgentProgressSummaries("thr-2")).toEqual([
      { text: "sibling phrase", atMs: 1_500 },
    ]);
  });

  it("drops malformed entries and blank agent ids", () => {
    const { store } = createTestContext();
    store.replaceAgentProgressSummaries({
      "  ": [{ text: "ignored", atMs: 1_000 }],
      "thr-1": [
        { text: "   ", atMs: 1_000 },
        { text: "valid phrase", atMs: Number.NaN },
        { text: "  kept phrase  ", atMs: 2_000 },
      ],
    });

    expect(store.listAgentProgressSummaries("thr-1")).toEqual([
      { text: "kept phrase", atMs: 2_000 },
    ]);
  });
});
