import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { buildBackgroundTaskLifecycleIndex } from "@/features/chat/lib/background-task-lifecycle";

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
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db),
  };
  activeContexts.add(context);
  return context;
};

const appendUserThreadMessages = (
  store: SessionStore,
  threadId: string,
  count: number,
  timestamp = 8_500,
) => {
  for (let index = 0; index < count; index += 1) {
    const content = `Graph message ${index}`;
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp,
      role: "user",
      content,
      payload: { role: "user", content, timestamp },
    });
  }
  return store.loadThreadMessages(threadId);
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

describe("session-store", () => {
  it("migrates v1 append-sequence rows to the canonical insertion sequence", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-session-store-v1-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(rootPath, { recursive: true });
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE runtime_thread_entries (
        entry_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_entry_id TEXT,
        entry_type TEXT NOT NULL,
        timestamp_iso TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        append_seq INTEGER,
        data_json TEXT
      );
      CREATE INDEX idx_runtime_thread_entries_thread_append
      ON runtime_thread_entries(thread_key, append_seq);
    `);
    const insertLegacy = db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, parent_entry_id, entry_type,
        timestamp_iso, created_at, append_seq, data_json
      ) VALUES (?, 'legacy-thread', 'legacy-session', ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = 1_700_000_000_000;
    insertLegacy.run(
      "legacy-random-z",
      null,
      "message",
      new Date(timestamp).toISOString(),
      timestamp,
      1,
      JSON.stringify({
        message: { role: "user", content: "Legacy first", timestamp },
      }),
    );
    insertLegacy.run(
      "legacy-random-a",
      "legacy-random-z",
      "custom_message",
      new Date(timestamp).toISOString(),
      timestamp,
      2,
      JSON.stringify({
        customType: "managed-child-terminal",
        content: "Legacy sibling event",
        display: false,
        eventId: "legacy-child-event",
      }),
    );
    insertLegacy.run(
      "legacy-random-m",
      "legacy-random-z",
      "message",
      new Date(timestamp).toISOString(),
      timestamp,
      3,
      JSON.stringify({
        message: { role: "user", content: "Legacy second", timestamp },
      }),
    );

    initializeDesktopDatabase(db);
    const context = { rootPath, db, store: new SessionStore(db) };
    activeContexts.add(context);

    expect(
      context.store
        .loadThreadMessages("legacy-thread")
        .map((message) => message.content),
    ).toEqual(["Legacy first", "Legacy sibling event", "Legacy second"]);
    const migrated = db
      .prepare(
        `SELECT insertion_sequence AS insertionSequence
         FROM runtime_thread_entries
         WHERE thread_key = 'legacy-thread'
         ORDER BY insertion_sequence`,
      )
      .all() as Array<{ insertionSequence: number }>;
    expect(migrated.map((row) => row.insertionSequence)).toEqual([1, 2, 3]);
    expect(
      db
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'index'
             AND name = 'idx_runtime_thread_entries_thread_append'`,
        )
        .get(),
    ).toBeUndefined();

    db.prepare(
      `INSERT INTO runtime_thread_entries (
         entry_id, thread_key, session_id, parent_entry_id, entry_type,
         timestamp_iso, created_at, data_json
       ) VALUES (?, 'legacy-thread', 'legacy-session', ?, 'message', ?, ?, ?)`,
    ).run(
      "legacy-random-new",
      "legacy-random-m",
      new Date(timestamp).toISOString(),
      timestamp,
      JSON.stringify({
        message: { role: "user", content: "Imported later", timestamp },
      }),
    );
    expect(
      db
        .prepare(
          `SELECT insertion_sequence AS insertionSequence
           FROM runtime_thread_entries
           WHERE entry_id = 'legacy-random-new'`,
        )
        .get(),
    ).toMatchObject({ insertionSequence: 4 });
  });

  it("migrates legacy agent rows with a zero ownership generation", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-session-store-legacy-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(rootPath, { recursive: true });
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE runtime_agents (
        thread_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_depth INTEGER NOT NULL,
        max_agent_depth INTEGER,
        parent_agent_id TEXT,
        self_mod_metadata_json TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        result TEXT,
        error TEXT,
        updated_at INTEGER NOT NULL,
        root_run_id TEXT
      );
      INSERT INTO runtime_agents (
        thread_id, conversation_id, agent_type, description, agent_depth,
        status, started_at, updated_at
      ) VALUES (
        'legacy-agent', 'legacy-conversation', 'general', 'Legacy row', 1,
        'completed', 1, 2
      );
    `);
    initializeDesktopDatabase(db);
    const context = { rootPath, db, store: new SessionStore(db) };
    activeContexts.add(context);

    expect(context.store.getAgentRecord("legacy-agent")).toMatchObject({
      threadId: "legacy-agent",
      attemptGeneration: 0,
    });
    const columns = db
      .prepare("PRAGMA table_info(runtime_agents)")
      .all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("model_config_json");
  });

  it("round-trips a subagent's inherited model configuration", () => {
    const { store } = createTestContext();
    const modelConfigSnapshot = {
      engine: "codex_cli" as const,
      routeModel: "stella/openai/gpt-5.6-sol",
      engineModel: "gpt-5.6-codex",
      reasoningEffort: "high" as const,
    };
    store.saveAgentRecord({
      threadId: "subagent-model-route",
      conversationId: "conversation-model-route",
      agentType: "general",
      description: "Coordinate work",
      agentDepth: 1,
      status: "completed",
      attemptGeneration: 2,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
      modelConfigSnapshot,
    });

    expect(
      store.getAgentRecord("subagent-model-route")?.modelConfigSnapshot,
    ).toEqual(modelConfigSnapshot);
    expect(
      store.listAgentRecordsByStatus("completed")[0]?.modelConfigSnapshot,
    ).toEqual(modelConfigSnapshot);
  });

  it("starts a fresh default conversation without deleting old messages", () => {
    const { store } = createTestContext();
    const firstConversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: firstConversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Keep this" },
    });

    const nextConversationId = store.createNewDefaultConversationId();

    expect(nextConversationId).not.toBe(firstConversationId);
    expect(store.getOrCreateDefaultConversationId()).toBe(nextConversationId);
    expect(
      store.listMessages(nextConversationId, { maxVisibleMessages: 10 })
        .messages,
    ).toEqual([]);
    expect(
      store
        .listMessages(firstConversationId, { maxVisibleMessages: 10 })
        .messages.map((message) => message.payload.text),
    ).toEqual(["Keep this"]);
  });

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
      payload: { toolName: "web", args: { query: "weather" } },
    });
    const assistantEvent = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_002,
      payload: { text: "Here are some options." },
    });

    expect(
      store.listEvents(conversationId, 10).map((event) => event.type),
    ).toEqual(["user_message", "tool_request", "assistant_message"]);
    expect(store.getEventCount(conversationId)).toBe(3);

    store.setSyncCheckpoint(conversationId, assistantEvent._id);
    expect(store.getSyncCheckpoint(conversationId)).toBe(assistantEvent._id);

    const messageRows = db
      .prepare(
        `
      SELECT id, type, role
      FROM message
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `,
      )
      .all(conversationId) as Array<{ id: string; type: string; role: string }>;
    expect(
      messageRows.map((row) => ({ type: row.type, role: row.role })),
    ).toEqual([
      { type: "user_message", role: "user" },
      { type: "tool_request", role: "tool" },
      { type: "assistant_message", role: "assistant" },
    ]);
    expect(messageRows[0]?.id).toBe(userEvent._id);
    expect(messageRows[2]?.id).toBe(assistantEvent._id);

    const oldTables = db
      .prepare(
        `
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
    `,
      )
      .all() as Array<{ name: string }>;
    expect(oldTables).toEqual([]);
  });

  it("anchors turn tools to the first assistant of the turn, falling back to the user_message when none exists", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const userA = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Make a chart" },
    });
    const assistantA = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "On it." },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_002,
      requestId: "req-1",
      payload: { toolName: "image_gen", args: {} },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_003,
      requestId: "req-1",
      payload: { toolName: "image_gen", resultPreview: "[image]" },
    });
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_004,
      payload: { agentId: "agent-1", result: "ok" },
    });

    const userB = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 2_000,
      payload: { text: "Try again" },
    });
    // Tool fires BEFORE any assistant in this second turn. No assistant
    // in turn → user_message is anchor.
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 2_001,
      requestId: "req-2",
      payload: { toolName: "image_gen", args: { prompt: "which?" } },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(messages.map((m) => m._id)).toEqual([
      userA._id,
      assistantA._id,
      userB._id,
    ]);
    expect(messages[0]?.toolEvents).toEqual([]);
    expect(messages[1]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
      "tool_result",
      "agent-completed",
    ]);
    expect(messages[2]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
    ]);
  });

  it("attaches pre-reply tool outputs to the assistant when one fires later in the turn", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    // Regression: orchestrator emits image_gen BEFORE its reply text.
    // The renderer derives inline artifact cards from assistant rows
    // only — these tools must anchor on the assistant to render.
    const userA = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "draw a cat" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_001,
      payload: { toolName: "image_gen", args: { prompt: "cat" } },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_002,
      payload: { toolName: "image_gen" },
    });
    const assistantA = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_003,
      payload: { text: "Here's the cat." },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(messages.map((m) => m._id)).toEqual([userA._id, assistantA._id]);
    expect(messages[0]?.toolEvents).toEqual([]);
    expect(messages[1]?.toolEvents.map((e) => e.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  it("does not anchor tool outputs to hidden assistant messages", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const userA = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "show this in HTML" },
    });
    const hiddenAssistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: {
        text: "[TOOL CALL: html]",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_002,
      payload: { toolName: "html" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_003,
      payload: { toolName: "html" },
    });
    const assistantA = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_004,
      payload: { text: "Done." },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });

    expect(messages.map((m) => m._id)).toEqual([
      userA._id,
      hiddenAssistant._id,
      assistantA._id,
    ]);
    expect(messages[1]?.toolEvents).toEqual([]);
    expect(messages[2]?.toolEvents.map((e) => e.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  it("reports visibleMessageCount excluding UI-hidden user messages", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "hi" },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "hello" },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_002,
      payload: {
        text: "<reminder>",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_003,
      payload: { text: "next prompt" },
    });

    const { messages, visibleMessageCount } = store.listMessages(
      conversationId,
      { maxVisibleMessages: 10 },
    );
    expect(messages).toHaveLength(4);
    // 3 visible (user, assistant, user) — the hidden reminder doesn't
    // count toward the chat's "how many visible messages do we have"
    // metric used for pagination.
    expect(visibleMessageCount).toBe(3);
  });

  it("listMessages caps the window by visible message count regardless of tool density", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 5; i += 1) {
      const baseTs = 1_000 + i * 100;
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: baseTs,
        payload: { text: `user ${i}` },
      });
      store.appendEvent({
        conversationId,
        type: "assistant_message",
        timestamp: baseTs + 1,
        payload: { text: `asst ${i}` },
      });
      // 10 tool events per turn — would dominate a raw-event cap.
      for (let t = 0; t < 10; t += 1) {
        store.appendEvent({
          conversationId,
          type: "tool_request",
          timestamp: baseTs + 2 + t,
          requestId: `req-${i}-${t}`,
          payload: { toolName: "exec_command", args: { cmd: "echo" } },
        });
      }
    }

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 4,
    });
    // 4 visible messages → 2 turns from the tail.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.payload?.text)).toEqual([
      "user 3",
      "asst 3",
      "user 4",
      "asst 4",
    ]);
    // Each assistant should keep its 10 turn tools (no raw-event cap
    // truncating them).
    expect(messages[1]?.toolEvents).toHaveLength(10);
    expect(messages[3]?.toolEvents).toHaveLength(10);
  });

  it("keeps tool events for the oldest assistant when the message window starts mid-turn", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "old setup" },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "old reply" },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 2_000,
      payload: { text: "draw a chart" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 2_001,
      requestId: "chart",
      payload: { toolName: "image_gen", args: { prompt: "chart" } },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 2_002,
      requestId: "chart",
      payload: { toolName: "image_gen", resultPreview: "[chart]" },
    });
    const cutoffAssistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 2_003,
      payload: { text: "Here is the chart." },
    });
    const latestUser = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 3_000,
      payload: { text: "thanks" },
    });

    const { messages, visibleMessageCount } = store.listMessages(
      conversationId,
      { maxVisibleMessages: 2 },
    );

    expect(visibleMessageCount).toBe(2);
    expect(messages.map((m) => m._id)).toEqual([
      cutoffAssistant._id,
      latestUser._id,
    ]);
    expect(messages[0]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  it("listMessages skips UI-hidden user messages when computing the visible cutoff", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    // 3 visible turns, then 5 hidden system reminders, then 2 more
    // visible turns. With maxVisibleMessages=4 the cutoff must look
    // past the hidden block to include 2 user messages from earlier
    // turns rather than returning just the 2 latest visible ones.
    for (let i = 0; i < 3; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 1_000 + i * 10,
        payload: { text: `early user ${i}` },
      });
    }
    for (let i = 0; i < 5; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 2_000 + i,
        payload: {
          text: `hidden reminder ${i}`,
          metadata: { ui: { visibility: "hidden" } },
        },
      });
    }
    for (let i = 0; i < 2; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 3_000 + i * 10,
        payload: { text: `late user ${i}` },
      });
    }

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 4,
    });
    // Window should contain the 4 most-recent VISIBLE messages, ignoring
    // hidden rows. Hidden rows still flow through but the surface filter
    // hides them at render time — they're returned here so optimistic
    // overlay merging can deduplicate against them.
    const visibleTexts = messages
      .filter((m) => {
        const visibility = (
          m.payload?.metadata as { ui?: { visibility?: string } } | undefined
        )?.ui?.visibility;
        return visibility !== "hidden";
      })
      .map((m) => m.payload?.text);
    expect(visibleTexts).toEqual([
      "early user 1",
      "early user 2",
      "late user 0",
      "late user 1",
    ]);
    // Hidden reminders ARE in the window (so optimistic overlays can
    // dedupe against them), but they didn't consume the cap.
    const hiddenTexts = messages
      .filter((m) => {
        const visibility = (
          m.payload?.metadata as { ui?: { visibility?: string } } | undefined
        )?.ui?.visibility;
        return visibility === "hidden";
      })
      .map((m) => m.payload?.text);
    expect(hiddenTexts).toHaveLength(5);
  });

  it("listMessagesBefore pages strictly older messages using the oldest-message cursor", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 6; i += 1) {
      const ts = 1_000 + i * 10;
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: ts,
        payload: { text: `user ${i}` },
      });
    }

    const { messages: latest } = store.listMessages(conversationId, {
      maxVisibleMessages: 3,
    });
    expect(latest.map((m) => m.payload?.text)).toEqual([
      "user 3",
      "user 4",
      "user 5",
    ]);

    const oldest = latest[0]!;
    const { messages: prior } = store.listMessagesBefore(conversationId, {
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
      maxVisibleMessages: 3,
    });
    expect(prior.map((m) => m.payload?.text)).toEqual([
      "user 0",
      "user 1",
      "user 2",
    ]);
  });

  it("listMessagesAfter returns only messages after the mobile cursor", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const first = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "already synced" },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_010,
      payload: { text: "new user" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_011,
      payload: {
        toolName: "exec_command",
        producedFiles: [{ path: "/tmp/report.pdf", kind: { type: "add" } }],
      },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_012,
      payload: { text: "new assistant" },
    });

    const { messages, sourceEvents } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: first.timestamp,
      afterId: first._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((m) => m.payload?.text)).toEqual([
      "new user",
      "new assistant",
    ]);
    expect(messages[1]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_result",
    ]);
    expect(sourceEvents.map((event) => event.type)).toEqual([
      "user_message",
      "tool_result",
      "assistant_message",
    ]);
  });

  it("listMessagesAfter returns an existing assistant when its turn gets a new artifact", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "make a report" },
    });
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_010,
      payload: { text: "Working on it." },
    });
    const artifact = store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_020,
      payload: {
        toolName: "html",
        filePath: "/Users/me/.stella/outputs/html/report.html",
      },
    });

    const { messages, sourceEvents } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: assistant.timestamp,
      afterId: assistant._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((m) => m._id)).toEqual([assistant._id]);
    expect(messages[0]?.toolEvents.map((event) => event._id)).toEqual([
      artifact._id,
    ]);
    expect(sourceEvents.map((event) => event._id)).toEqual([artifact._id]);
  });

  it("listMessagesAfter returns existing rows when agent lifecycle state changes", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "run background work" },
    });
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_010,
      payload: { text: "Working on it." },
    });
    const started = store.appendEvent({
      conversationId,
      type: "agent-started",
      timestamp: 1_020,
      payload: { agentId: "task-1", description: "Check docs" },
    });
    const progress = store.appendEvent({
      conversationId,
      type: "agent-progress",
      timestamp: 1_030,
      payload: { agentId: "task-1", statusText: "Reading docs" },
    });
    const failed = store.appendEvent({
      conversationId,
      type: "agent-failed",
      timestamp: 1_040,
      payload: { agentId: "task-1", error: "Timed out" },
    });

    const { messages, sourceEvents } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: assistant.timestamp,
      afterId: assistant._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((message) => message._id)).toEqual([assistant._id]);
    expect(messages[0]?.toolEvents.map((event) => event._id)).toEqual([
      started._id,
      progress._id,
      failed._id,
    ]);
    expect(sourceEvents.map((event) => event._id)).toEqual([
      started._id,
      progress._id,
      failed._id,
    ]);
  });

  it("keeps listMessages bounded when the requested visible window exceeds the scan ceiling", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 4_050; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 1_000 + i,
        payload: { text: `user ${i}` },
      });
    }

    const { messages, visibleMessageCount } = store.listMessages(
      conversationId,
      { maxVisibleMessages: 4_001 },
    );

    expect(visibleMessageCount).toBe(4_000);
    expect(messages).toHaveLength(4_000);
    expect(messages[0]?.payload?.text).toBe("user 50");
    expect(messages.at(-1)?.payload?.text).toBe("user 4049");
  });

  it("listActivity returns only lifecycle events", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Plan a trip" },
    });
    store.appendEvent({
      conversationId,
      type: "agent-started",
      timestamp: 1_010,
      payload: {
        agentId: "general-1",
        description: "Researching destinations",
        agentType: "general",
      },
    });
    store.appendEvent({
      conversationId,
      type: "agent-progress",
      timestamp: 1_020,
      payload: { agentId: "general-1", statusText: "Reading guides" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_021,
      requestId: "tool-1",
      payload: { toolName: "web", args: { query: "weather" } },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_030,
      payload: { text: "Here you go." },
    });
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_040,
      payload: { agentId: "general-1", result: "Done" },
    });

    const { activities } = store.listActivity(conversationId);

    expect(activities.map((event) => event.type)).toEqual([
      "agent-started",
      "agent-progress",
      "agent-completed",
    ]);
  });

  it("listActivity pages older activity via beforeTimestampMs/beforeId", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 6; i += 1) {
      const ts = 1_000 + i * 10;
      store.appendEvent({
        conversationId,
        type: "agent-started",
        timestamp: ts,
        payload: {
          agentId: `agent-${i}`,
          description: `task ${i}`,
          agentType: "general",
        },
      });
    }

    const { activities: latest } = store.listActivity(conversationId, {
      limit: 3,
    });
    expect(
      latest.map((event) => (event.payload as { agentId: string })?.agentId),
    ).toEqual(["agent-3", "agent-4", "agent-5"]);

    const oldest = latest[0]!;
    const { activities: older } = store.listActivity(conversationId, {
      limit: 3,
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
    });
    expect(
      older.map((event) => (event.payload as { agentId: string })?.agentId),
    ).toEqual(["agent-0", "agent-1", "agent-2"]);
  });

  it("listFiles returns only events whose payload carries fileChanges or producedFiles", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Edit something" },
    });
    // tool_result without any file changes — should be excluded.
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_010,
      requestId: "tool-1",
      payload: { toolName: "web", result: "ok" },
    });
    // tool_result with fileChanges — should be included.
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_020,
      requestId: "tool-2",
      payload: {
        toolName: "apply_patch",
        fileChanges: [{ kind: { type: "create" }, path: "/repo/src/new.ts" }],
      },
    });
    // tool_result with empty fileChanges array — should be excluded.
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_025,
      requestId: "tool-3",
      payload: {
        toolName: "apply_patch",
        fileChanges: [],
        producedFiles: [],
      },
    });
    // agent-completed with producedFiles — should be included.
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_030,
      payload: {
        agentId: "general-1",
        producedFiles: [
          { path: "/out/report.pdf", mimeType: "application/pdf" },
        ],
      },
    });
    // agent-completed without files — should be excluded.
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_040,
      payload: { agentId: "general-2", result: "Done" },
    });

    const { files } = store.listFiles(conversationId);
    expect(files.map((event) => event._id)).toEqual(
      files.map((event) => event._id),
    );
    expect(files.map((event) => event.type)).toEqual([
      "tool_result",
      "agent-completed",
    ]);
    expect(files[0]?.timestamp).toBe(1_020);
    expect(files[1]?.timestamp).toBe(1_030);
  });

  it("listFiles pages older file events via beforeTimestampMs/beforeId", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 6; i += 1) {
      const ts = 1_000 + i * 10;
      store.appendEvent({
        conversationId,
        type: "tool_result",
        timestamp: ts,
        requestId: `tool-${i}`,
        payload: {
          toolName: "apply_patch",
          fileChanges: [
            { kind: { type: "create" }, path: `/repo/file-${i}.ts` },
          ],
        },
      });
    }

    const { files: latest } = store.listFiles(conversationId, { limit: 3 });
    expect(latest.map((event) => event.timestamp)).toEqual([
      1_030, 1_040, 1_050,
    ]);

    const oldest = latest[0]!;
    const { files: older } = store.listFiles(conversationId, {
      limit: 3,
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
    });
    expect(older.map((event) => event.timestamp)).toEqual([
      1_000, 1_010, 1_020,
    ]);
  });

  it("upserts local chat events by explicit event id", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      eventId: "assistant-for-user-1",
      type: "assistant_message",
      timestamp: 1_000,
      requestId: "user-1",
      payload: { text: "First draft", userMessageId: "user-1" },
    });
    store.appendEvent({
      conversationId,
      eventId: "assistant-for-user-1",
      type: "assistant_message",
      timestamp: 1_001,
      requestId: "user-1",
      payload: { text: "Final answer", userMessageId: "user-1" },
    });

    const events = store.listEvents(conversationId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _id: "assistant-for-user-1",
      type: "assistant_message",
      requestId: "user-1",
      payload: { text: "Final answer", userMessageId: "user-1" },
    });
  });

  it("keeps each assistant message in a single user turn as its own row", () => {
    // The worker writes one `assistant-msg-<runId>-<seq>` row per
    // assistant message in a run (preamble, post-tool answer, …) so
    // they render linearly in chronological order rather than
    // collapsing into a single overwriting row. Sanity-check that the
    // store happily round-trips two distinct rows that share the same
    // requestId/userMessageId.
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const userMessageId = "user-web-turn";

    store.appendEvent({
      conversationId,
      eventId: `assistant-msg-run-1-2`,
      type: "assistant_message",
      timestamp: 1_000,
      requestId: userMessageId,
      payload: {
        text: "Let me look that up.",
        userMessageId,
      },
    });
    store.appendEvent({
      conversationId,
      eventId: `assistant-msg-run-1-5`,
      type: "assistant_message",
      timestamp: 1_001,
      requestId: userMessageId,
      payload: {
        text: "Here is what I found from the web.",
        userMessageId,
      },
    });

    const events = store.listEvents(conversationId, 10);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload?.text)).toEqual([
      "Let me look that up.",
      "Here is what I found from the web.",
    ]);
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

    const threadRows = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'message'
    `,
      )
      .get(threadId) as { count: number };
    expect(threadRows.count).toBe(2);
  });

  it("keeps many frozen-time agent thread entries linear and complete across a full reload", () => {
    const context = createTestContext();
    const { rootPath, db, store } = context;
    const frozenAt = 7_000;
    vi.spyOn(Date, "now").mockReturnValue(frozenAt);
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-frozen-agent",
      agentType: "general",
    });
    store.saveAgentRecord({
      threadId,
      conversationId: "conv-frozen-agent",
      agentType: "general",
      description: "Coordinate frozen-time work",
      agentDepth: 1,
      status: "running",
      attemptGeneration: 9,
      startedAt: frozenAt,
      completedAt: null,
      updatedAt: frozenAt,
    });

    const messageCount = 240;
    for (let index = 0; index < messageCount; index += 1) {
      const content = `Frozen message ${index}`;
      const assistant = index % 2 === 1;
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: frozenAt,
        role: assistant ? "assistant" : "user",
        content,
        payload: assistant
          ? {
              role: "assistant",
              content: [{ type: "text", text: content }],
              api: "openai-responses",
              provider: "openai",
              model: "gpt-5.4",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: frozenAt,
            }
          : { role: "user", content, timestamp: frozenAt },
      });
    }

    const entryRows = db
      .prepare(
        `
      SELECT
        entry_id AS entryId,
        parent_entry_id AS parentEntryId,
        insertion_sequence AS insertionSequence
      FROM runtime_thread_entries
      WHERE thread_key = ?
      ORDER BY insertion_sequence ASC
    `,
      )
      .all(threadId) as Array<{
      entryId: string;
      parentEntryId: string | null;
      insertionSequence: number;
    }>;
    expect(entryRows).toHaveLength(messageCount);
    expect(new Set(entryRows.map((row) => row.insertionSequence)).size).toBe(
      messageCount,
    );
    for (let index = 1; index < entryRows.length; index += 1) {
      expect(entryRows[index]?.parentEntryId).toBe(
        entryRows[index - 1]?.entryId,
      );
    }

    db.close();
    activeContexts.delete(context);
    const reopenedDb = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(reopenedDb);
    const reopened = {
      rootPath,
      db: reopenedDb,
      store: new SessionStore(reopenedDb),
    };
    activeContexts.add(reopened);

    const reloaded = reopened.store.loadThreadMessages(threadId);
    expect(reloaded).toHaveLength(messageCount);
    expect(reloaded.map((message) => message.content)).toEqual(
      Array.from(
        { length: messageCount },
        (_, index) => `Frozen message ${index}`,
      ),
    );
    expect(reopened.store.loadThreadMessages(threadId, 200)).toHaveLength(200);
    expect(reopened.store.loadThreadMessages(threadId, 200)[0]?.content).toBe(
      "Frozen message 40",
    );
    expect(reopened.store.getAgentRecord(threadId)).toMatchObject({
      attemptGeneration: 9,
      status: "running",
      description: "Coordinate frozen-time work",
    });
  });

  it("rehydrates equal-timestamp lifecycle terminals onto their durable attempt", () => {
    const context = createTestContext();
    const { rootPath, db, store } = context;
    const conversationId = "conv-same-ms-lifecycle";
    const timestamp = 7_500;
    const append = (
      eventId: string,
      type: string,
      payload: Record<string, unknown>,
    ) =>
      store.appendEvent({
        eventId,
        conversationId,
        timestamp,
        type,
        payload,
      });

    append("z-start-old", "agent-started", {
      agentId: "same-ms-agent",
      agentType: "general",
      description: "Prior attempt",
      rootRunId: "same-root",
      attemptGeneration: 21,
    });
    append("a-terminal-old", "agent-completed", {
      agentId: "same-ms-agent",
      rootRunId: "same-root",
      attemptGeneration: 21,
      result: "Prior result",
    });
    append("a-start-current", "agent-started", {
      agentId: "same-ms-agent",
      agentType: "general",
      description: "Current attempt",
      rootRunId: "same-root",
      attemptGeneration: 22,
      isFollowUp: true,
    });
    append("b-terminal-current", "agent-canceled", {
      agentId: "same-ms-agent",
      rootRunId: "same-root",
      attemptGeneration: 22,
      error: "Paused current attempt",
    });

    db.close();
    activeContexts.delete(context);
    const reopenedDb = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(reopenedDb);
    const reopened = {
      rootPath,
      db: reopenedDb,
      store: new SessionStore(reopenedDb),
    };
    activeContexts.add(reopened);

    const reloaded = reopened.store.listActivity(conversationId).activities;
    expect(reloaded.map((event) => event._id)).toEqual([
      "a-start-current",
      "a-terminal-old",
      "b-terminal-current",
      "z-start-old",
    ]);
    const index = buildBackgroundTaskLifecycleIndex(reloaded);
    expect(index.byStartEventId.get("z-start-old")).toMatchObject({
      attemptGeneration: 21,
      status: "completed",
      terminalEventId: "a-terminal-old",
    });
    expect(index.byStartEventId.get("a-start-current")).toMatchObject({
      attemptGeneration: 22,
      status: "canceled",
      terminalEventId: "b-terminal-current",
      errorText: "Paused current attempt",
    });
    expect(index.startEventIdByLifecycleEventId.get("a-terminal-old")).toBe(
      "z-start-old",
    );
    expect(index.startEventIdByLifecycleEventId.get("b-terminal-current")).toBe(
      "a-start-current",
    );
  });

  it("orders imported legacy rows by insertion and recovers an old accidental branch", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-imported-thread",
      agentType: "general",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_000,
      role: "user",
      content: "Imported base",
      payload: { role: "user", content: "Imported base", timestamp: 8_000 },
    });
    const base = db
      .prepare(
        `SELECT entry_id AS entryId, session_id AS sessionId
         FROM runtime_thread_entries WHERE thread_key = ? LIMIT 1`,
      )
      .get(threadId) as { entryId: string; sessionId: string };
    const insertLegacy = db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, parent_entry_id, entry_type,
        timestamp_iso, created_at, insertion_sequence, data_json
      ) VALUES (?, ?, ?, ?, 'message', ?, ?, NULL, ?)
    `);
    insertLegacy.run(
      "legacy-random-z",
      threadId,
      base.sessionId,
      base.entryId,
      new Date(8_000).toISOString(),
      8_000,
      JSON.stringify({
        message: { role: "user", content: "Imported second", timestamp: 8_000 },
      }),
    );
    insertLegacy.run(
      "legacy-random-a",
      threadId,
      base.sessionId,
      base.entryId,
      new Date(8_000).toISOString(),
      8_000,
      JSON.stringify({
        message: { role: "user", content: "Imported third", timestamp: 8_000 },
      }),
    );
    initializeDesktopDatabase(db);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM runtime_thread_entries
             WHERE thread_key = ? AND insertion_sequence IS NULL`,
          )
          .get(threadId) as { count: number }
      ).count,
    ).toBe(0);

    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual(["Imported base", "Imported second", "Imported third"]);
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_000,
      role: "user",
      content: "Appended after import",
      payload: {
        role: "user",
        content: "Appended after import",
        timestamp: 8_000,
      },
    });
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Imported base",
      "Imported second",
      "Imported third",
      "Appended after import",
    ]);
  });

  it("repairs rows inserted during the insertion-sequence migration window", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-partial-sequence-migration",
      agentType: "general",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_000,
      role: "user",
      content: "Before migration window",
      payload: {
        role: "user",
        content: "Before migration window",
        timestamp: 8_000,
      },
    });
    const base = db
      .prepare(
        `SELECT entry_id AS entryId, session_id AS sessionId
         FROM runtime_thread_entries WHERE thread_key = ? LIMIT 1`,
      )
      .get(threadId) as { entryId: string; sessionId: string };
    const insertMessage = db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, parent_entry_id, entry_type,
        timestamp_iso, created_at, data_json
      ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?)
    `);

    db.exec("DROP TRIGGER trg_runtime_thread_entries_sequence;");
    insertMessage.run(
      "partial-migration-null",
      threadId,
      base.sessionId,
      base.entryId,
      new Date(8_001).toISOString(),
      8_001,
      JSON.stringify({
        message: {
          role: "user",
          content: "Inside migration window",
          timestamp: 8_001,
        },
      }),
    );
    db.exec(`
      CREATE TRIGGER trg_runtime_thread_entries_sequence
      AFTER INSERT ON runtime_thread_entries
      WHEN NEW.insertion_sequence IS NULL
      BEGIN
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT COALESCE(MAX(insertion_sequence), 0) + 1
          FROM runtime_thread_entries
        )
        WHERE rowid = NEW.rowid;
      END;
    `);
    insertMessage.run(
      "partial-migration-assigned",
      threadId,
      base.sessionId,
      "partial-migration-null",
      new Date(8_002).toISOString(),
      8_002,
      JSON.stringify({
        message: {
          role: "user",
          content: "After migration window",
          timestamp: 8_002,
        },
      }),
    );

    expect(() => initializeDesktopDatabase(db)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT insertion_sequence AS insertionSequence
           FROM runtime_thread_entries
           WHERE thread_key = ?
           ORDER BY rowid`,
        )
        .all(threadId),
    ).toEqual([
      { insertionSequence: 1 },
      { insertionSequence: 2 },
      { insertionSequence: 3 },
    ]);
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Before migration window",
      "Inside migration window",
      "After migration window",
    ]);
  });

  it("recovers a self-cycled imported thread for transcript load and compaction", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-self-cycle",
      agentType: "general",
    });
    const messages = appendUserThreadMessages(store, threadId, 3);
    const newestId = messages.at(-1)!.entryId!;
    db.prepare(
      `UPDATE runtime_thread_entries
       SET parent_entry_id = entry_id
       WHERE entry_id = ?`,
    ).run(newestId);

    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual(["Graph message 0", "Graph message 1", "Graph message 2"]);
    store.compactThread({
      threadKey: threadId,
      summary: "Recovered self-cycle",
      fromEntryId: messages[0]!.entryId!,
      toEntryId: messages[1]!.entryId!,
      tokensBefore: 30,
      timestamp: 8_600,
    });
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      expect.stringContaining("Recovered self-cycle"),
      "Graph message 2",
    ]);
  });

  it("recovers a newest-row multi-node cycle without losing available entries", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-multi-cycle",
      agentType: "general",
    });
    const messages = appendUserThreadMessages(store, threadId, 4);
    const previousId = messages[2]!.entryId!;
    const newestId = messages[3]!.entryId!;
    const updateParent = db.prepare(
      `UPDATE runtime_thread_entries SET parent_entry_id = ? WHERE entry_id = ?`,
    );
    updateParent.run(newestId, previousId);
    updateParent.run(previousId, newestId);

    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Graph message 0",
      "Graph message 1",
      "Graph message 2",
      "Graph message 3",
    ]);
    store.compactThread({
      threadKey: threadId,
      summary: "Recovered multi-cycle",
      fromEntryId: messages[0]!.entryId!,
      toEntryId: messages[1]!.entryId!,
      tokensBefore: 40,
      timestamp: 8_600,
    });
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      expect.stringContaining("Recovered multi-cycle"),
      "Graph message 2",
      "Graph message 3",
    ]);
  });

  it("recovers a disconnected imported parent graph deterministically", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-disconnected-graph",
      agentType: "general",
    });
    const messages = appendUserThreadMessages(store, threadId, 3);
    db.prepare(
      `UPDATE runtime_thread_entries
       SET parent_entry_id = 'missing-imported-parent'
       WHERE entry_id = ?`,
    ).run(messages[1]!.entryId!);

    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual(["Graph message 0", "Graph message 1", "Graph message 2"]);
    store.compactThread({
      threadKey: threadId,
      summary: "Recovered disconnected graph",
      fromEntryId: messages[0]!.entryId!,
      toEntryId: messages[1]!.entryId!,
      tokensBefore: 30,
      timestamp: 8_600,
    });
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      expect.stringContaining("Recovered disconnected graph"),
      "Graph message 2",
    ]);
  });

  it("preserves assistant thinking blocks in persisted thread payloads", () => {
    const { store } = createTestContext();
    const conversationId = "conv-thinking";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_000,
      role: "assistant",
      content: "Final answer",
      payload: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Check the relevant files first.",
            thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
          },
          { type: "text", text: "Final answer" },
        ],
        api: "openai-completions",
        provider: "stella",
        model: "openai/gpt-5.4",
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
        timestamp: 3_000,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.payload).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Check the relevant files first.",
          thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
        },
        { type: "text", text: "Final answer" },
      ],
      api: "openai-completions",
      provider: "stella",
      model: "openai/gpt-5.4",
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
      timestamp: 3_000,
    });
  });

  it("compacts thread history using append-only session entries", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-compact";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_000,
      role: "user",
      content: "First request",
      payload: {
        role: "user",
        content: "First request",
        timestamp: 4_000,
      },
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_001,
      role: "assistant",
      content: "First answer",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
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
        timestamp: 4_001,
      },
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_002,
      role: "user",
      content: "Latest request",
      payload: {
        role: "user",
        content: "Latest request",
        timestamp: 4_002,
      },
    });

    const beforeCompaction = store.loadThreadMessages(threadId);
    expect(beforeCompaction).toHaveLength(3);

    store.compactThread({
      threadKey: threadId,
      summary: "Condensed earlier work",
      fromEntryId: beforeCompaction[0]!.entryId!,
      toEntryId: beforeCompaction[1]!.entryId!,
      tokensBefore: 1234,
      timestamp: 4_100,
    });

    const afterCompaction = store.loadThreadMessages(threadId);
    expect(afterCompaction).toHaveLength(2);
    expect(afterCompaction[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("[[THREAD_CHECKPOINT]]"),
    });
    expect(afterCompaction[1]).toMatchObject({
      role: "user",
      content: "Latest request",
    });

    const compactionRows = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'compaction'
    `,
      )
      .get(threadId) as { count: number };
    expect(compactionRows.count).toBe(1);
  });

  it("applies later compaction overlays over the same raw message range", () => {
    const { store } = createTestContext();
    const conversationId = "conv-compact-overlay";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    for (let index = 0; index < 4; index += 1) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 5_000 + index,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Message ${index}`,
        payload:
          index % 2 === 0
            ? {
                role: "user",
                content: `Message ${index}`,
                timestamp: 5_000 + index,
              }
            : {
                role: "assistant",
                content: [{ type: "text", text: `Message ${index}` }],
                api: "openai-responses",
                provider: "openai",
                model: "gpt-5.4",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop",
                timestamp: 5_000 + index,
              },
      });
    }

    const initial = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Initial summary",
      fromEntryId: initial[0]!.entryId!,
      toEntryId: initial[1]!.entryId!,
      tokensBefore: 500,
      timestamp: 5_100,
    });

    const afterFirstCompaction = store.loadThreadMessages(threadId);
    expect(afterFirstCompaction.map((message) => message.content)).toEqual([
      expect.stringContaining("[[THREAD_CHECKPOINT]]"),
      "Message 2",
      "Message 3",
    ]);

    const secondPass = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Updated summary",
      fromEntryId: secondPass[1]!.entryId!,
      toEntryId: secondPass[2]!.entryId!,
      tokensBefore: 900,
      timestamp: 5_200,
    });

    const afterSecondCompaction = store.loadThreadMessages(threadId);
    expect(afterSecondCompaction).toHaveLength(1);
    expect(afterSecondCompaction[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Updated summary"),
    });
  });

  it("truncates oversized persisted tool results to stay under SQLite row limits", () => {
    const { store } = createTestContext();
    const conversationId = "conv-big-tool-result";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    // Must exceed THREAD_ROW_MAX_BYTES (6 MB) to trigger the
    // "too large to persist" placeholder path. Multi-MB rows under the cap
    // are intentionally allowed (screenshot tool results land in this range).
    const largeOutput = "A".repeat(8_000_000);
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_000,
      role: "toolResult",
      content: largeOutput,
      toolCallId: "tool-call-1",
      payload: {
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "Read",
        content: [{ type: "text", text: largeOutput }],
        isError: false,
        timestamp: 6_000,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.payload).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-call-1",
    });
    const persistedText =
      loaded[0]?.payload?.role === "toolResult"
        ? loaded[0].payload.content[0]
        : null;
    expect(persistedText).toMatchObject({
      type: "text",
      text: expect.stringContaining("too large to persist in storage"),
    });
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

    const runtimeThread = db
      .prepare(
        `
      SELECT
        conversation_id AS conversationId,
        agent_type AS agentType,
        status
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(conversationId) as {
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

describe("thread activity rows", () => {
  it("degrades a persisted retired-type thread into an ordinary one", () => {
    const { store, db } = createTestContext();
    // A row written by an install that still had the Manager agent, with a
    // General child hanging off it — exactly what an existing user DB holds.
    db.exec(`
      INSERT INTO runtime_agents (
        thread_id, conversation_id, agent_type, description, agent_depth,
        status, started_at, completed_at, result, updated_at,
        manager_turn_state_json
      ) VALUES (
        'legacy-manager', 'conv-legacy', 'manager', 'Coordinate the rollout', 1,
        'completed', 1000, 2000, 'Consolidated report.', 2000,
        '{"reportSequence":2,"finalMessage":"Consolidated report."}'
      );
    `);
    store.saveAgentRecord({
      threadId: "legacy-child",
      conversationId: "conv-legacy",
      agentType: "general",
      description: "Managed child",
      agentDepth: 2,
      parentAgentId: "legacy-manager",
      status: "completed",
      startedAt: 1_100,
      completedAt: 1_900,
      result: "Child done.",
      updatedAt: 1_900,
    });

    // Reads as a plain General thread rather than an unknown type, so the
    // Activity feed (which admits only known types) still shows it and its
    // child still renders beneath it as an ordinary parent/child hierarchy.
    const record = store.getAgentRecord("legacy-manager");
    expect(record).toMatchObject({
      threadId: "legacy-manager",
      agentType: "general",
      status: "completed",
      result: "Consolidated report.",
    });

    const rows = store.listThreadActivity("conv-legacy");
    expect(rows.map((row) => row.threadId).sort()).toEqual([
      "legacy-child",
      "legacy-manager",
    ]);
    const projected = rows.find((row) => row.threadId === "legacy-manager");
    expect(projected?.agentType).toBe("general");
    expect(projected?.description).toBe("Coordinate the rollout");
    expect(
      rows.find((row) => row.threadId === "legacy-child")?.parentAgentId,
    ).toBe("legacy-manager");

    // Reinterpreted on read, never rewritten: the stored row is untouched and
    // the retired column is simply ignored.
    const stored = db
      .prepare("SELECT agent_type FROM runtime_agents WHERE thread_id = ?")
      .get("legacy-manager") as { agent_type: string };
    expect(stored.agent_type).toBe("manager");
  });

  it("projects one authoritative row per thread", () => {
    const { store } = createTestContext();
    store.saveAgentRecord({
      threadId: "research-flights",
      conversationId: "conv-1",
      agentType: "general",
      description: "Research flights",
      agentDepth: 0,
      status: "running",
      rootRunId: "root-1",
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_500,
    });
    store.saveAgentRecord({
      threadId: "book-hotel",
      conversationId: "conv-1",
      agentType: "general",
      description: "Book the hotel",
      agentDepth: 0,
      status: "completed",
      rootRunId: "root-2",
      startedAt: 2_000,
      completedAt: 3_000,
      result: "Booked the Marriott",
      updatedAt: 3_000,
    });
    // Other conversations stay out of the projection.
    store.saveAgentRecord({
      threadId: "other-thread",
      conversationId: "conv-2",
      agentType: "general",
      description: "Other work",
      agentDepth: 0,
      status: "running",
      startedAt: 500,
      completedAt: null,
      updatedAt: 500,
    });

    const rows = store.listThreadActivity("conv-1");
    expect(rows.map((row) => row.threadId)).toEqual([
      "research-flights",
      "book-hotel",
    ]);
    expect(rows[0]).toMatchObject({
      status: "running",
      description: "Research flights",
      rootRunId: "root-1",
      startedAt: 1_000,
    });
    expect(rows[1]).toMatchObject({
      status: "completed",
      completedAt: 3_000,
      result: "Booked the Marriott",
    });
  });

  it("reflects the latest upsert — a follow-up's re-description and rebind win", () => {
    const { store } = createTestContext();
    const base = {
      threadId: "research-flights",
      conversationId: "conv-1",
      agentType: "general",
      description: "Research flights",
      agentDepth: 0,
      status: "running" as const,
      rootRunId: "root-1",
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_000,
    };
    store.saveAgentRecord(base);
    store.saveAgentRecord({
      ...base,
      description: "Search for the itinerary email",
      rootRunId: "root-2",
      updatedAt: 2_000,
    });
    store.saveAgentRecord({
      ...base,
      description: "Search for the itinerary email",
      rootRunId: "root-2",
      status: "completed",
      completedAt: 3_000,
      result: "Found it",
      updatedAt: 3_000,
    });

    const rows = store.listThreadActivity("conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: "Search for the itinerary email",
      rootRunId: "root-2",
      status: "completed",
      completedAt: 3_000,
      result: "Found it",
    });
  });
});
