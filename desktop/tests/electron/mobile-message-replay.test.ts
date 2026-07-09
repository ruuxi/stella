import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { LocalChatHistoryService } from "../../electron/services/local-chat-history-service.js";

const roots = new Set<string>();

const createService = (root?: string) => {
  const stellaAppDir =
    root ??
    path.join(
      os.tmpdir(),
      `stella-mobile-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  roots.add(stellaAppDir);
  return {
    root: stellaAppDir,
    service: new LocalChatHistoryService({ stellaAppDir }),
  };
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("mobile message replay acceptance", () => {
  it("uses the canonical user row as a durable acceptance receipt across restart", () => {
    const conversationId = "conversation-1";
    const sendId = "mobile:send-1";
    const first = createService();

    expect(
      first.service.hasEvent({
        conversationId,
        eventId: sendId,
        type: "user_message",
      }),
    ).toBe(false);
    first.service.appendEvent({
      conversationId,
      eventId: sendId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "hello" },
    });
    expect(
      first.service.hasEvent({
        conversationId,
        eventId: sendId,
        type: "user_message",
      }),
    ).toBe(true);

    first.service.close();
    const reopened = createService(first.root).service;
    expect(
      reopened.hasEvent({
        conversationId,
        eventId: sendId,
        type: "user_message",
      }),
    ).toBe(true);
    // Acceptance is global to the canonical primary key, not the desktop's
    // currently-active conversation. A replay after the user changes desktop
    // conversations must not upsert/move the accepted row into the new one.
    expect(
      reopened.hasEventId({ eventId: sendId, type: "user_message" }),
    ).toBe(true);
    const sync = reopened.syncMessages({ conversationId, maxMessages: 100 });
    expect(sync.messages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({
        localMessageId: sendId,
        role: "user",
        text: "hello",
      }),
    ]);
    reopened.close();
  });

  it("dedupes by identity, not text, including timestamp ties and interleaving", () => {
    const { service } = createService();
    const conversationId = "conversation-1";
    service.appendEvent({
      conversationId,
      eventId: "mobile:a",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "same" },
    });
    service.appendEvent({
      conversationId,
      eventId: "desktop:between",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "desktop" },
    });
    service.appendEvent({
      conversationId,
      eventId: "mobile:b",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "same" },
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant:a",
      type: "assistant_message",
      requestId: "mobile:a",
      timestamp: 1_001,
      payload: { text: "reply" },
    });

    const rows = service.syncMessages({ conversationId, maxMessages: 100 }).messages;
    expect(rows.filter((message) => message.role === "user")).toHaveLength(3);
    expect(rows.filter((message) => message.text === "same")).toHaveLength(2);
    expect(new Set(rows.map((message) => message.localMessageId)).size).toBe(
      rows.length,
    );
    expect(rows.find((message) => message.localMessageId === "assistant:a"))
      .toMatchObject({ requestId: "mobile:a" });
    service.close();
  });
});
