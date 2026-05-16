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
      payload: { toolName: "web", args: { query: "weather" } },
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
    // Tool fires BEFORE any assistant in this second turn (askQuestion
    // as first action). No assistant in turn → user_message is anchor.
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 2_001,
      requestId: "req-2",
      payload: { toolName: "askQuestion", args: { question: "which?" } },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(messages.map((m) => m._id)).toEqual([userA._id, assistantA._id, userB._id]);
    expect(messages[0]?.toolEvents).toEqual([]);
    expect(
      messages[1]?.toolEvents.map((event) => event.type),
    ).toEqual(["tool_request", "tool_result", "agent-completed"]);
    expect(
      messages[2]?.toolEvents.map((event) => event.type),
    ).toEqual(["tool_request"]);
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
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'message'
    `).get(threadId) as { count: number };
    expect(threadRows.count).toBe(2);
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

    const compactionRows = db.prepare(`
      SELECT COUNT(*) AS count
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'compaction'
    `).get(threadId) as { count: number };
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
