import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalChatHistoryService } from "../../electron/services/local-chat-history-service.js";

const services: LocalChatHistoryService[] = [];

const createService = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-mobile-sync-task-"));
  const service = new LocalChatHistoryService({ stellaAppDir: root });
  services.push(service);
  return service;
};

afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("incremental mobile task context", () => {
  it("does not read the full transcript for an empty delta", () => {
    const service = createService();
    const conversationId = "conversation-empty";
    service.appendEvent({
      conversationId,
      eventId: "user-1",
      type: "user_message",
      payload: { text: "hello" },
      timestamp: 1,
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant-1",
      type: "assistant_message",
      payload: { text: "hi" },
      timestamp: 2,
    });
    const cursor = service.syncMessages({ conversationId }).cursor;
    const store = (service as unknown as { store: { listMessages: Function } })
      .store;
    const listMessages = vi.spyOn(store, "listMessages" as never);

    const delta = service.syncMessages({ conversationId, sinceCursor: cursor });

    expect(delta.messages).toEqual([]);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("replays a spawning anchor without projecting the latest 100 messages", () => {
    const service = createService();
    const conversationId = "conversation-anchor";
    service.appendEvent({
      conversationId,
      eventId: "user-spawn",
      type: "user_message",
      payload: { text: "start background work" },
      timestamp: 10,
    });
    service.appendEvent({
      conversationId,
      eventId: "agent-start",
      type: "agent-started",
      payload: { agentId: "agent-1", description: "Research" },
      timestamp: 11,
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant-spawn",
      type: "assistant_message",
      payload: { text: "Working on it" },
      timestamp: 12,
    });
    service.appendEvent({
      conversationId,
      eventId: "user-later",
      type: "user_message",
      payload: { text: "another turn" },
      timestamp: 20,
    });
    service.appendEvent({
      conversationId,
      eventId: "assistant-later",
      type: "assistant_message",
      payload: { text: "another answer" },
      timestamp: 21,
    });
    const cursor = service.syncMessages({ conversationId }).cursor;
    service.appendEvent({
      conversationId,
      eventId: "agent-complete",
      type: "agent-completed",
      payload: { agentId: "agent-1", description: "Research" },
      timestamp: 22,
    });
    const store = (service as unknown as { store: { listMessages: Function } })
      .store;
    const listMessages = vi.spyOn(store, "listMessages" as never);

    const delta = service.syncMessages({ conversationId, sinceCursor: cursor });

    expect(listMessages).not.toHaveBeenCalled();
    expect(
      delta.messages.some(
        (message) => message.localMessageId === "assistant-spawn",
      ),
    ).toBe(true);
    const tasks = delta.messages.flatMap((message) => message.tasks ?? []);
    expect(tasks.find((task) => task.id === "agent-1")?.status).toBe(
      "completed",
    );
  });
});
