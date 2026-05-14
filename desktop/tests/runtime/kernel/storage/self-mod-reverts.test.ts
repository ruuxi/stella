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
    `stella-revert-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SqliteDatabase;
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

describe("self-mod reverts ledger (via SessionStore)", () => {
  it("records a revert with both conversation + origin thread slots pending", () => {
    const { store } = createTestContext();
    const conversationId = "conv-1";
    const originThreadKey = "agent-thread-x";

    expect(store.listPendingOrchestratorReverts(conversationId)).toHaveLength(
      0,
    );
    expect(store.listPendingOriginThreadReverts(originThreadKey)).toHaveLength(
      0,
    );

    const recorded = store.recordSelfModRevert({
      conversationId,
      originThreadKey,
      featureId: "abcdef0",
      files: ["desktop/src/foo.tsx", "desktop/src/bar.tsx"],
      revertedAt: 1_000,
    });
    expect(recorded.revertId).toBeTruthy();
    expect(recorded.originThreadKey).toBe(originThreadKey);
    expect(recorded.consumedByOrchestrator).toBe(false);
    expect(recorded.consumedByOriginThread).toBe(false);

    expect(store.listPendingOrchestratorReverts(conversationId)).toHaveLength(
      1,
    );
    expect(store.listPendingOriginThreadReverts(originThreadKey)).toHaveLength(
      1,
    );
  });

  it("auto-marks origin-thread slot consumed when no originThreadKey is given (legacy commit)", () => {
    const { store } = createTestContext();
    const recorded = store.recordSelfModRevert({
      conversationId: "conv-1",
      // omit originThreadKey
      featureId: "old-commit",
      files: ["foo.ts"],
    });

    expect(recorded.originThreadKey).toBeNull();
    expect(recorded.consumedByOriginThread).toBe(true);
    expect(store.listPendingOrchestratorReverts("conv-1")).toHaveLength(1);
    // No thread key to match — nothing pending on the thread slot.
    expect(store.listPendingOriginThreadReverts("anything")).toHaveLength(0);
  });

  it("orchestrator consume marks only the orchestrator slot", () => {
    const { store } = createTestContext();
    const recorded = store.recordSelfModRevert({
      conversationId: "conv-1",
      originThreadKey: "thread-x",
      featureId: "abc",
      files: ["a.ts"],
    });

    store.markSelfModRevertsOrchestratorConsumed([recorded.revertId]);

    expect(store.listPendingOrchestratorReverts("conv-1")).toHaveLength(0);
    expect(store.listPendingOriginThreadReverts("thread-x")).toHaveLength(1);
  });

  it("origin-thread consume marks only the origin-thread slot", () => {
    const { store } = createTestContext();
    const recorded = store.recordSelfModRevert({
      conversationId: "conv-1",
      originThreadKey: "thread-x",
      featureId: "abc",
      files: ["a.ts"],
    });

    store.markSelfModRevertsOriginThreadConsumed([recorded.revertId]);

    expect(store.listPendingOrchestratorReverts("conv-1")).toHaveLength(1);
    expect(store.listPendingOriginThreadReverts("thread-x")).toHaveLength(0);
  });

  it("scopes pending reverts to the conversation/thread they were recorded against", () => {
    const { store } = createTestContext();

    store.recordSelfModRevert({
      conversationId: "conv-a",
      originThreadKey: "thread-a",
      featureId: "aaa",
      files: ["a.ts"],
    });
    store.recordSelfModRevert({
      conversationId: "conv-b",
      originThreadKey: "thread-b",
      featureId: "bbb",
      files: ["b.ts"],
    });

    expect(store.listPendingOrchestratorReverts("conv-a")).toHaveLength(1);
    expect(store.listPendingOrchestratorReverts("conv-b")).toHaveLength(1);
    expect(store.listPendingOrchestratorReverts("conv-c")).toHaveLength(0);
    expect(store.listPendingOriginThreadReverts("thread-a")).toHaveLength(1);
    expect(store.listPendingOriginThreadReverts("thread-b")).toHaveLength(1);
    expect(store.listPendingOriginThreadReverts("thread-c")).toHaveLength(0);
  });

  it("returns pending reverts in revertedAt order so reminder text is stable", () => {
    const { store } = createTestContext();

    store.recordSelfModRevert({
      conversationId: "conv-1",
      originThreadKey: "thread-x",
      featureId: "second",
      files: [],
      revertedAt: 2_000,
    });
    store.recordSelfModRevert({
      conversationId: "conv-1",
      originThreadKey: "thread-x",
      featureId: "first",
      files: [],
      revertedAt: 1_000,
    });

    expect(
      store.listPendingOrchestratorReverts("conv-1").map((r) => r.featureId),
    ).toEqual(["first", "second"]);
    expect(
      store.listPendingOriginThreadReverts("thread-x").map((r) => r.featureId),
    ).toEqual(["first", "second"]);
  });

  it("no-ops both consume methods when given an empty id list", () => {
    const { store } = createTestContext();
    expect(() =>
      store.markSelfModRevertsOrchestratorConsumed([]),
    ).not.toThrow();
    expect(() =>
      store.markSelfModRevertsOriginThreadConsumed([]),
    ).not.toThrow();
  });
});

describe("mergeEventPayload", () => {
  it("merges a patch into an existing assistant message payload", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const userMessageId = "user-msg-1";

    store.appendEvent({
      conversationId,
      type: "user_message",
      eventId: userMessageId,
      timestamp: 1_000,
      payload: { text: "Make it red" },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      eventId: `assistant-for-${userMessageId}`,
      requestId: userMessageId,
      timestamp: 1_500,
      payload: {
        text: "Done.",
        userMessageId,
      },
    });

    const updated = store.mergeEventPayload({
      conversationId,
      eventId: `assistant-for-${userMessageId}`,
      patch: {
        selfModApplied: {
          featureId: "abc1234",
          files: ["desktop/src/foo.css"],
          batchIndex: 0,
        },
      },
    });

    expect(updated).not.toBeNull();
    expect(updated?.payload?.text).toBe("Done.");
    expect(updated?.payload?.userMessageId).toBe(userMessageId);
    expect(updated?.payload?.selfModApplied).toEqual({
      featureId: "abc1234",
      files: ["desktop/src/foo.css"],
      batchIndex: 0,
    });

    // Persisted: a fresh read sees the merged shape.
    const events = store.listEvents(conversationId, 10);
    const assistant = events.find(
      (event) => event._id === `assistant-for-${userMessageId}`,
    );
    expect(assistant?.payload?.selfModApplied).toEqual({
      featureId: "abc1234",
      files: ["desktop/src/foo.css"],
      batchIndex: 0,
    });
  });

  it("returns null when the target event does not exist", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const result = store.mergeEventPayload({
      conversationId,
      eventId: "assistant-for-missing",
      patch: { selfModApplied: { featureId: "x", files: [], batchIndex: 0 } },
    });

    expect(result).toBeNull();
  });
});
