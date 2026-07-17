import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  SessionStore,
} from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import type { ThreadActivityUpdatedPayload } from "../../../../../runtime/contracts/local-chat.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (
  onThreadAssistantUpdate?: (payload: ThreadActivityUpdatedPayload) => void,
): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-agent-messages-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db, { onThreadAssistantUpdate }),
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

const EMPTY_USAGE = {
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
};

const appendAssistant = (
  store: SessionStore,
  args: {
    threadId: string;
    timestamp: number;
    text: string;
    stopReason?: "toolUse" | "stop";
    attemptGeneration?: number;
  },
) => {
  const stopReason = args.stopReason ?? "toolUse";
  store.appendThreadMessage({
    threadKey: args.threadId,
    timestamp: args.timestamp,
    role: "assistant",
    content: args.text,
    payload: {
      role: "assistant",
      content: args.text ? [{ type: "text", text: args.text }] : [],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "codex",
      usage: EMPTY_USAGE,
      stopReason,
      timestamp: args.timestamp,
      stellaAttemptGeneration: args.attemptGeneration ?? 0,
    } as never,
  });
};

const saveRunningAgent = (
  store: SessionStore,
  args: {
    threadId: string;
    conversationId?: string;
    startedAt: number;
    attemptGeneration?: number;
    agentType?: string;
    updatedAt?: number;
  },
) => {
  store.saveAgentRecord({
    threadId: args.threadId,
    conversationId: args.conversationId ?? "conv-1",
    agentType: args.agentType ?? "general",
    description: `Work for ${args.threadId}`,
    agentDepth: 0,
    status: "running",
    attemptGeneration: args.attemptGeneration ?? 0,
    startedAt: args.startedAt,
    completedAt: null,
    updatedAt: args.updatedAt ?? args.startedAt,
  });
};

describe("agent-authored assistant updates", () => {
  it("reads recent assistant messages verbatim and ignores legacy generated rows", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-1",
      agentType: "general",
      threadId: "agent-1",
      nameHint: "Inspect the routes",
    });
    saveRunningAgent(store, { threadId, startedAt: 1_000 });

    for (const [index, content] of [
      "Oldest update",
      "I checked the route.\n\nIt already redirects safely.",
      "I removed the stale action.",
      "The focused tests pass.",
    ].entries()) {
      appendAssistant(store, {
        threadId,
        timestamp: 1_000 + index,
        text: content,
      });
    }
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_000,
      role: "toolResult",
      toolCallId: "tool-1",
      content: "tool output must not become an agent update",
    });
    db.prepare(
      `INSERT INTO agent_progress_summaries (agent_id, text, created_at)
       VALUES (?, ?, ?)`,
    ).run(threadId, "old generated summary", 3_000);

    expect(store.listAgentAssistantMessages(threadId, 3)).toEqual([
      {
        text: "I checked the route.\n\nIt already redirects safely.",
        atMs: 1_001,
      },
      { text: "I removed the stale action.", atMs: 1_002 },
      { text: "The focused tests pass.", atMs: 1_003 },
    ]);
  });

  it("projects the same assistant messages into Activity rows", () => {
    const { store } = createTestContext();
    saveRunningAgent(store, { threadId: "agent-1", startedAt: 1_000 });
    appendAssistant(store, {
      threadId: "agent-1",
      timestamp: 1_001,
      text: "I found the stale navigation path.",
    });

    expect(store.listThreadActivity("conv-1")[0]).toEqual(
      expect.objectContaining({
        assistantMessages: ["I found the stale navigation path."],
        assistantMessagesUpdatedAt: 1_001,
      }),
    );
  });

  it("scopes updates to the current attempt and excludes terminal answers", () => {
    const { store } = createTestContext();
    const threadId = "agent-reused";
    saveRunningAgent(store, { threadId, startedAt: 1_000 });
    appendAssistant(store, {
      threadId,
      timestamp: 1_100,
      text: "Old attempt preamble",
    });
    appendAssistant(store, {
      threadId,
      timestamp: 1_200,
      text: "Old final answer",
      stopReason: "stop",
    });

    saveRunningAgent(store, {
      threadId,
      startedAt: 2_000,
      attemptGeneration: 1,
    });
    appendAssistant(store, {
      threadId,
      timestamp: 2_001,
      text: "Current attempt preamble",
      attemptGeneration: 1,
    });
    appendAssistant(store, {
      threadId,
      timestamp: 2_002,
      text: "Late write from old attempt",
      attemptGeneration: 0,
    });
    appendAssistant(store, {
      threadId,
      timestamp: 2_003,
      text: "Current final answer",
      stopReason: "stop",
      attemptGeneration: 1,
    });

    expect(store.listAgentAssistantMessages(threadId)).toEqual([
      { text: "Current attempt preamble", atMs: 2_001 },
    ]);
  });

  it("emits a bounded mobile-compatible update only after persistence", () => {
    const onThreadAssistantUpdate = vi.fn();
    const { store } = createTestContext(onThreadAssistantUpdate);
    saveRunningAgent(store, {
      threadId: "agent-1",
      startedAt: 1_000,
      attemptGeneration: 4,
    });

    appendAssistant(store, {
      threadId: "agent-1",
      timestamp: 1_001,
      text: "I am checking the live route.",
      attemptGeneration: 4,
    });
    expect(onThreadAssistantUpdate).toHaveBeenCalledOnce();
    expect(onThreadAssistantUpdate).toHaveBeenLastCalledWith({
      conversationId: "conv-1",
      assistantUpdate: expect.objectContaining({
        threadId: "agent-1",
        assistantMessages: ["I am checking the live route."],
        reasoningSummaries: ["I am checking the live route."],
        latestMessage: "I am checking the live route.",
        atMs: 1_001,
        attemptGeneration: 4,
      }),
    });

    appendAssistant(store, {
      threadId: "agent-1",
      timestamp: 1_002,
      text: "The final answer",
      stopReason: "stop",
      attemptGeneration: 4,
    });
    expect(onThreadAssistantUpdate).toHaveBeenCalledOnce();
  });

  it("bounds active visible task queries per thread and overall", () => {
    const { store } = createTestContext();
    const oversized = "🧭".repeat(
      AGENT_ASSISTANT_UPDATE_LIMITS.messageChars * 2,
    );
    const totalAgents = AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads + 3;
    for (let agentIndex = 0; agentIndex < totalAgents; agentIndex += 1) {
      const threadId = `agent-${agentIndex}`;
      saveRunningAgent(store, {
        threadId,
        startedAt: 1_000,
        updatedAt: 10_000 - agentIndex,
      });
      for (let messageIndex = 0; messageIndex < 5; messageIndex += 1) {
        appendAssistant(store, {
          threadId,
          timestamp: 1_100 + messageIndex,
          text: `${agentIndex}:${messageIndex}:${oversized}`,
        });
      }
    }
    saveRunningAgent(store, {
      threadId: "internal-agent",
      startedAt: 1_000,
      agentType: "recall",
      updatedAt: 20_000,
    });
    appendAssistant(store, {
      threadId: "internal-agent",
      timestamp: 1_100,
      text: "Internal update",
    });

    const records = store.listThreadActivity("conv-1");
    const projected = records.flatMap(
      (record) => record.assistantMessages ?? [],
    );
    const recordsWithUpdates = records.filter(
      (record) => record.assistantMessages?.length,
    );
    expect(recordsWithUpdates).toHaveLength(
      AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads,
    );
    expect(
      recordsWithUpdates.every(
        (record) =>
          (record.assistantMessages?.length ?? 0) <=
          AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
      ),
    ).toBe(true);
    expect(
      recordsWithUpdates.every(
        (record) =>
          (record.assistantMessages ?? []).reduce(
            (sum, message) => sum + [...message].length,
            0,
          ) <= AGENT_ASSISTANT_UPDATE_LIMITS.threadChars &&
          (record.assistantMessages ?? []).reduce(
            (sum, message) => sum + Buffer.byteLength(message, "utf8"),
            0,
          ) <= AGENT_ASSISTANT_UPDATE_LIMITS.threadBytes,
      ),
    ).toBe(true);
    expect(
      projected.every(
        (message) =>
          [...message].length <= AGENT_ASSISTANT_UPDATE_LIMITS.messageChars &&
          Buffer.byteLength(message, "utf8") <=
            AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
      ),
    ).toBe(true);
    expect(
      projected.reduce((sum, message) => sum + [...message].length, 0),
    ).toBeLessThanOrEqual(AGENT_ASSISTANT_UPDATE_LIMITS.totalChars);
    expect(
      projected.reduce(
        (sum, message) => sum + Buffer.byteLength(message, "utf8"),
        0,
      ),
    ).toBeLessThanOrEqual(AGENT_ASSISTANT_UPDATE_LIMITS.totalBytes);
    expect(
      recordsWithUpdates.every((record) =>
        record.assistantMessages?.at(-1)?.includes(":4:"),
      ),
    ).toBe(true);
    expect(
      records.find((record) => record.threadId === "internal-agent")
        ?.assistantMessages,
    ).toBeUndefined();
    expect(store.listAgentAssistantMessages("internal-agent")).toEqual([]);
  });
});
