import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-session-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db),
  };
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

describe("session-store", () => {
  it("reconstructs chat events from session, message, and part rows", () => {
    const { db, store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const userEvent = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Plan a trip" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_001,
      requestId: "tool-1",
      payload: { toolName: "WebSearch", args: { query: "weather" } },
    });
    const assistantEvent = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_002,
      payload: { text: "Here are some options." },
    });

    expect(store.listEvents(conversationId, 10).map((event) => event.type)).toEqual([
      "user_message",
      "tool_request",
      "assistant_message",
    ]);
    expect(store.getEventCount(conversationId)).toBe(3);

    store.setSyncCheckpoint(conversationId, assistantEvent._id);
    expect(store.getSyncCheckpoint(conversationId)).toBe(assistantEvent._id);

    const messageRows = db.prepare(`
      SELECT id, type, role
      FROM message
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(conversationId) as Array<{ id: string; type: string; role: string }>;
    expect(messageRows.map((row) => ({ type: row.type, role: row.role }))).toEqual([
      { type: "user_message", role: "user" },
      { type: "tool_request", role: "tool" },
      { type: "assistant_message", role: "assistant" },
    ]);
    expect(messageRows[0]?.id).toBe(userEvent._id);
    expect(messageRows[2]?.id).toBe(assistantEvent._id);

    const oldTables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'chat_conversations',
          'chat_events',
          'chat_sync_checkpoints',
          'runtime_thread_messages',
          'runtime_run_events',
          'runtime_memories'
        )
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;
    expect(oldTables).toEqual([]);
  });

  it("loads runtime thread history from shared message parts", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-thread";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_000,
      role: "user",
      content: "Summarize this file",
      payload: {
        role: "user",
        content: "Summarize this file",
        timestamp: 2_000,
      },
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_001,
      role: "assistant",
      content: "Summary complete",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "Summary complete" }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2_001,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      role: "user",
      content: "Summarize this file",
    });
    expect(loaded[1]).toMatchObject({
      role: "assistant",
      content: "Summary complete",
    });
    expect(loaded[1]?.payload).toMatchObject({
      role: "assistant",
      model: "claude-sonnet",
    });

    const threadRows = db.prepare(`
      SELECT COUNT(*) AS count
      FROM message
      WHERE thread_key = ?
        AND type = 'thread_message'
    `).get(threadId) as { count: number };
    expect(threadRows.count).toBe(2);
  });

  it("lazily registers implicit orchestrator thread keys", () => {
    const { db, store } = createTestContext();
    const conversationId = "01kp5755c8mz3dpc22zas71d97";

    store.appendThreadMessage({
      threadKey: conversationId,
      timestamp: 3_000,
      role: "user",
      content: "Hello from the orchestrator thread",
      payload: {
        role: "user",
        content: "Hello from the orchestrator thread",
        timestamp: 3_000,
      },
    });

    const loaded = store.loadThreadMessages(conversationId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("Hello from the orchestrator thread");

    const runtimeThread = db.prepare(`
      SELECT
        conversation_id AS conversationId,
        agent_type AS agentType,
        status
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(conversationId) as {
      conversationId: string;
      agentType: string;
      status: string;
    };
    expect(runtimeThread).toEqual({
      conversationId,
      agentType: "orchestrator",
      status: "evicted",
    });
  });
});
