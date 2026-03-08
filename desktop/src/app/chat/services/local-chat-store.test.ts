import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendLocalEvent,
  buildLocalHistoryMessages,
  buildLocalSyncMessages,
  getLocalSyncCheckpoint,
  getOrCreateLocalConversationId,
  listLocalEvents,
  setLocalSyncCheckpoint,
  subscribeToLocalChatUpdates,
} from "./local-chat-store";

const STORE_KEY = "stella.localChat.v1";
const DEFAULT_CONVERSATION_KEY = "stella.localChat.defaultConversationId";
const SYNC_CHECKPOINTS_KEY = "stella.localChat.syncCheckpoints.v1";

describe("local-chat-store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("creates a default conversation ID and initializes its conversation bucket", () => {
    const conversationId = getOrCreateLocalConversationId();

    expect(conversationId.length).toBeGreaterThan(0);
    expect(localStorage.getItem(DEFAULT_CONVERSATION_KEY)).toBe(conversationId);

    const rawStore = localStorage.getItem(STORE_KEY);
    expect(rawStore).toBeTruthy();
    const parsedStore = JSON.parse(rawStore ?? "{}") as {
      conversations?: Record<string, unknown>;
    };
    expect(parsedStore.conversations?.[conversationId]).toBeTruthy();
  });

  it("reuses existing default conversation ID when present", () => {
    localStorage.setItem(DEFAULT_CONVERSATION_KEY, "conv-existing");

    expect(getOrCreateLocalConversationId()).toBe("conv-existing");
  });

  it("recovers from malformed persisted store data", () => {
    localStorage.setItem(STORE_KEY, "{malformed");

    appendLocalEvent({
      conversationId: "conv-1",
      type: "user_message",
      eventId: "e-1",
      timestamp: 1,
      payload: { text: "hello" },
    });

    const events = listLocalEvents("conv-1", 10);
    expect(events).toHaveLength(1);
    expect(events[0]?._id).toBe("e-1");
  });

  it("lists events sorted by timestamp, then by ID when timestamps tie", () => {
    appendLocalEvent({
      conversationId: "conv-sort",
      type: "assistant_message",
      eventId: "b",
      timestamp: 2,
      payload: { text: "second-b" },
    });
    appendLocalEvent({
      conversationId: "conv-sort",
      type: "assistant_message",
      eventId: "a",
      timestamp: 2,
      payload: { text: "second-a" },
    });
    appendLocalEvent({
      conversationId: "conv-sort",
      type: "user_message",
      eventId: "c",
      timestamp: 1,
      payload: { text: "first" },
    });

    const events = listLocalEvents("conv-sort", 10);
    expect(events.map((event) => event._id)).toEqual(["c", "a", "b"]);
  });

  it("trims oldest events once MAX_EVENTS_PER_CONVERSATION is exceeded", () => {
    const conversationId = "conv-trim";
    for (let i = 1; i <= 2002; i += 1) {
      appendLocalEvent({
        conversationId,
        type: "user_message",
        eventId: `e-${i}`,
        timestamp: i,
        payload: { text: `message-${i}` },
      });
    }

    const events = listLocalEvents(conversationId, 5000);
    expect(events).toHaveLength(2000);
    expect(events[0]?._id).toBe("e-3");
    expect(events.at(-1)?._id).toBe("e-2002");
  });

  it("builds history from chat messages only and enforces max messages", () => {
    const conversationId = "conv-history";
    appendLocalEvent({
      conversationId,
      type: "user_message",
      eventId: "u-1",
      timestamp: 1000,
      payload: { text: "hello" },
    });
    appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-1",
      timestamp: 2000,
      payload: { text: "hi there" },
    });
    appendLocalEvent({
      conversationId,
      type: "tool_request",
      eventId: "tool-1",
      timestamp: 3000,
      requestId: "req-1",
      payload: { toolName: "Read", args: { path: "/tmp/test" } },
    });
    appendLocalEvent({
      conversationId,
      type: "tool_result",
      eventId: "tool-1-result",
      timestamp: 4000,
      requestId: "req-1",
      payload: { toolName: "Read", result: "file contents" },
    });
    appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-2",
      timestamp: 5000,
      payload: { text: "done" },
    });

    const history = buildLocalHistoryMessages(conversationId);
    // Now includes tool calls and results, with timestamps
    expect(history.length).toBe(5); // user + assistant + tool_request + tool_result + assistant
    expect(history[0]!.role).toBe("user");
    expect(history[0]!.content).toContain("hello");
    expect(history[1]!.role).toBe("assistant");
    expect(history[1]!.content).toContain("hi there");
    expect(history[2]!.role).toBe("assistant"); // tool call -> assistant role
    expect(history[2]!.content).toContain("[Tool call] Read");
    expect(history[3]!.role).toBe("user"); // tool result -> user role
    expect(history[3]!.content).toContain("[Tool result] Read");
    expect(history[4]!.role).toBe("assistant");
    expect(history[4]!.content).toContain("done");
  });

  it("builds sync messages and only carries deviceId for user messages", () => {
    const conversationId = "conv-sync";
    appendLocalEvent({
      conversationId,
      type: "user_message",
      eventId: "u-1",
      timestamp: 10,
      deviceId: "device-1",
      payload: { text: "hello" },
    });
    appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-1",
      timestamp: 11,
      deviceId: "device-2",
      payload: { text: "hi" },
    });

    const messages = buildLocalSyncMessages(conversationId, 10);
    expect(messages).toEqual([
      {
        localMessageId: "u-1",
        role: "user",
        text: "hello",
        timestamp: 10,
        deviceId: "device-1",
      },
      {
        localMessageId: "a-1",
        role: "assistant",
        text: "hi",
        timestamp: 11,
      },
    ]);
  });

  it("stores and returns sync checkpoints", () => {
    expect(getLocalSyncCheckpoint("conv-checkpoint")).toBeNull();

    setLocalSyncCheckpoint("conv-checkpoint", "local-99");
    expect(getLocalSyncCheckpoint("conv-checkpoint")).toBe("local-99");

    const raw = localStorage.getItem(SYNC_CHECKPOINTS_KEY);
    expect(raw).toBeTruthy();
  });

  it("notifies subscribers on custom update and relevant storage events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalChatUpdates(listener);

    appendLocalEvent({
      conversationId: "conv-sub",
      type: "user_message",
      eventId: "sub-1",
      timestamp: 1,
      payload: { text: "hello" },
    });
    expect(listener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent("storage", { key: STORE_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();

    appendLocalEvent({
      conversationId: "conv-sub",
      type: "assistant_message",
      eventId: "sub-2",
      timestamp: 2,
      payload: { text: "bye" },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

