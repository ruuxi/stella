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
} from "../../../../../src/app/chat/services/local-chat-store";
import type { ChannelEnvelope, EventRecord } from "../../../../../src/app/chat/lib/event-transforms";
import { formatMessageTimestamp } from "../../../../../src/app/chat/lib/history-messages";

type LocalChatApiMock = NonNullable<typeof window.electronAPI>["localChat"];

const sortEventsAscending = (events: EventRecord[]) =>
  [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a._id.localeCompare(b._id);
  });

const installLocalChatApiMock = (initialDefaultConversationId = "conv-default") => {
  const listeners = new Set<() => void>();
  const conversations = new Map<string, EventRecord[]>();
  const checkpoints = new Map<string, string>();
  let defaultConversationId = initialDefaultConversationId;
  let generatedId = 0;

  const ensureConversation = (conversationId: string) => {
    const existing = conversations.get(conversationId);
    if (existing) return existing;
    const created: EventRecord[] = [];
    conversations.set(conversationId, created);
    return created;
  };

  const emitUpdated = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const api: LocalChatApiMock = {
    getOrCreateDefaultConversationId: vi.fn(async () => {
      ensureConversation(defaultConversationId);
      return defaultConversationId;
    }),
    listEvents: vi.fn(async ({ conversationId, maxItems = 200 }) => {
      const sorted = sortEventsAscending(conversations.get(conversationId) ?? []);
      return sorted.length <= maxItems ? sorted : sorted.slice(sorted.length - maxItems);
    }),
    getEventCount: vi.fn(async ({ conversationId }) => (conversations.get(conversationId) ?? []).length),
    appendEvent: vi.fn(async (args) => {
      const event: EventRecord = {
        _id: args.eventId ?? `event-${++generatedId}`,
        timestamp: args.timestamp ?? Date.now(),
        type: args.type,
        ...(args.deviceId ? { deviceId: args.deviceId } : {}),
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(args.targetDeviceId ? { targetDeviceId: args.targetDeviceId } : {}),
        ...(args.payload && typeof args.payload === "object"
          ? { payload: args.payload as Record<string, unknown> }
          : {}),
        ...(args.channelEnvelope && typeof args.channelEnvelope === "object"
          ? { channelEnvelope: args.channelEnvelope as ChannelEnvelope }
          : {}),
      };

      const events = ensureConversation(args.conversationId);
      events.push(event);
      const sorted = sortEventsAscending(events);
      conversations.set(
        args.conversationId,
        sorted.length <= 2000 ? sorted : sorted.slice(sorted.length - 2000),
      );
      emitUpdated();
      return event;
    }),
    listSyncMessages: vi.fn(async ({ conversationId, maxMessages = 2000 }) => {
      const events = sortEventsAscending(conversations.get(conversationId) ?? []);
      const messages = events.flatMap((event) => {
        if (event.type !== "user_message" && event.type !== "assistant_message") {
          return [];
        }
        const text =
          typeof event.payload?.contextText === "string"
            ? event.payload.contextText
            : typeof event.payload?.text === "string"
              ? event.payload.text
              : "";
        if (!text) return [];

        const role: "user" | "assistant" =
          event.type === "user_message" ? "user" : "assistant";
        return [{
          localMessageId: event._id,
          role,
          text,
          timestamp: event.timestamp,
          ...(role === "user" && event.deviceId ? { deviceId: event.deviceId } : {}),
        }];
      });
      return messages.length <= maxMessages ? messages : messages.slice(messages.length - maxMessages);
    }),
    getSyncCheckpoint: vi.fn(async ({ conversationId }) => checkpoints.get(conversationId) ?? null),
    setSyncCheckpoint: vi.fn(async ({ conversationId, localMessageId }) => {
      checkpoints.set(conversationId, localMessageId);
      return { ok: true };
    }),
    onUpdated: vi.fn((callback: () => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
  };

  window.electronAPI = {
    localChat: api,
  } as unknown as typeof window.electronAPI;

  return {
    api,
    setDefaultConversationId: (conversationId: string) => {
      defaultConversationId = conversationId;
    },
  };
};

describe("local-chat-store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installLocalChatApiMock();
  });

  it("gets the default conversation ID from the Electron transcript store", async () => {
    const conversationId = await getOrCreateLocalConversationId();

    expect(conversationId).toBe("conv-default");
    expect(window.electronAPI?.localChat.getOrCreateDefaultConversationId).toHaveBeenCalledTimes(1);
  });

  it("reuses the Electron default conversation ID when requested again", async () => {
    const { setDefaultConversationId } = installLocalChatApiMock("conv-existing");
    setDefaultConversationId("conv-existing");

    await expect(getOrCreateLocalConversationId()).resolves.toBe("conv-existing");
    await expect(getOrCreateLocalConversationId()).resolves.toBe("conv-existing");
  });

  it("lists events sorted by timestamp, then by ID when timestamps tie", async () => {
    await appendLocalEvent({
      conversationId: "conv-sort",
      type: "assistant_message",
      eventId: "b",
      timestamp: 2,
      payload: { text: "second-b" },
    });
    await appendLocalEvent({
      conversationId: "conv-sort",
      type: "assistant_message",
      eventId: "a",
      timestamp: 2,
      payload: { text: "second-a" },
    });
    await appendLocalEvent({
      conversationId: "conv-sort",
      type: "user_message",
      eventId: "c",
      timestamp: 1,
      payload: { text: "first" },
    });

    const events = await listLocalEvents("conv-sort", 10);
    expect(events.map((event) => event._id)).toEqual(["c", "a", "b"]);
  });

  it("stores local timestamps in contextText for user messages while keeping visible text raw", async () => {
    const timestamp = Date.UTC(2026, 2, 8, 20, 5, 0);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { tag } = formatMessageTimestamp(timestamp, undefined, timezone);

    const event = await appendLocalEvent({
      conversationId: "conv-stamp",
      type: "user_message",
      timestamp,
      payload: {
        text: "[8:05 PM] from channel",
        source: "channel:discord",
      },
      channelEnvelope: {
        provider: "discord",
        kind: "message",
        sourceTimestamp: timestamp,
      },
    });

    expect(event.payload?.text).toBe("[8:05 PM] from channel");
    expect(event.payload?.contextText).toBe(`from channel\n\n${tag}`);
  });

  it("skips contextText for assistant messages (timestamp added by history builder)", async () => {
    const event = await appendLocalEvent({
      conversationId: "conv-stamp-asst",
      type: "assistant_message",
      timestamp: Date.UTC(2026, 2, 8, 20, 10, 0),
      payload: { text: "here is my reply" },
    });

    expect(event.payload?.text).toBe("here is my reply");
    expect(event.payload?.contextText).toBeUndefined();
  });

  it("trims oldest events once MAX_EVENTS_PER_CONVERSATION is exceeded", async () => {
    const conversationId = "conv-trim";
    for (let i = 1; i <= 2002; i += 1) {
      await appendLocalEvent({
        conversationId,
        type: "user_message",
        eventId: `e-${i}`,
        timestamp: i,
        payload: { text: `message-${i}` },
      });
    }

    const events = await listLocalEvents(conversationId, 5000);
    expect(events).toHaveLength(2000);
    expect(events[0]?._id).toBe("e-3");
    expect(events.at(-1)?._id).toBe("e-2002");
  });

  it("builds history from local transcript events", async () => {
    const conversationId = "conv-history";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await appendLocalEvent({
      conversationId,
      type: "user_message",
      eventId: "u-1",
      timestamp: 1000,
      payload: { text: "hello" },
    });
    await appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-1",
      timestamp: 2000,
      payload: { text: "hi there" },
    });
    await appendLocalEvent({
      conversationId,
      type: "tool_request",
      eventId: "tool-1",
      timestamp: 3000,
      requestId: "req-1",
      payload: { toolName: "Read", args: { path: "/tmp/test" } },
    });
    await appendLocalEvent({
      conversationId,
      type: "tool_result",
      eventId: "tool-1-result",
      timestamp: 4000,
      requestId: "req-1",
      payload: { toolName: "Read", result: "file contents" },
    });
    await appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-2",
      timestamp: 5000,
      payload: { text: "done" },
    });
    const history = await buildLocalHistoryMessages(conversationId);
    // User messages have contextText set at storage time (local timezone).
    // Assistant messages get timestamps from the history builder's fallback path.
    const firstAssistantTag = formatMessageTimestamp(2000, undefined, timezone);
    const secondAssistantTag = formatMessageTimestamp(5000, firstAssistantTag.dateStr, timezone);
    expect(history).toHaveLength(5);
    expect(history[0]!.role).toBe("user");
    expect(history[0]!.content).toBe(
      `hello\n\n${formatMessageTimestamp(1000, undefined, timezone).tag}`,
    );
    expect(history[1]!.role).toBe("assistant");
    expect(history[1]!.content).toBe(
      `hi there\n\n${firstAssistantTag.tag}`,
    );
    expect(history[2]!.role).toBe("assistant");
    expect(history[2]!.content).toContain("[Tool call] Read");
    expect(history[3]!.role).toBe("user");
    expect(history[3]!.content).toContain("[Tool result] Read");
    expect(history[4]!.role).toBe("assistant");
    expect(history[4]!.content).toBe(
      `done\n\n${secondAssistantTag.tag}`,
    );
  });

  it("builds history with event timestamp for assistant messages (no contextText)", async () => {
    const conversationId = "conv-history-source-time";
    const eventTimestamp = Date.UTC(2026, 2, 8, 20, 10, 0);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    await appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-source",
      timestamp: eventTimestamp,
      payload: { text: "from channel" },
      channelEnvelope: {
        provider: "discord",
        kind: "message",
        sourceTimestamp: Date.UTC(2026, 2, 8, 20, 5, 0),
      },
    });
    const history = await buildLocalHistoryMessages(conversationId);
    const { tag } = formatMessageTimestamp(eventTimestamp, undefined, timezone);

    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      role: "assistant",
      content: `from channel\n\n${tag}`,
    });
  });

  it("builds sync messages and only carries deviceId for user messages", async () => {
    const conversationId = "conv-sync";
    await appendLocalEvent({
      conversationId,
      type: "user_message",
      eventId: "u-1",
      timestamp: 10,
      deviceId: "device-1",
      payload: { text: "hello" },
    });
    await appendLocalEvent({
      conversationId,
      type: "assistant_message",
      eventId: "a-1",
      timestamp: 11,
      deviceId: "device-2",
      payload: { text: "hi" },
    });

    const messages = await buildLocalSyncMessages(conversationId, 10);
    expect(messages).toEqual([
      {
        localMessageId: "u-1",
        role: "user",
        text: expect.stringContaining("hello"),
        timestamp: 10,
        deviceId: "device-1",
      },
      {
        localMessageId: "a-1",
        role: "assistant",
        text: expect.stringContaining("hi"),
        timestamp: 11,
      },
    ]);
  });

  it("stores and returns sync checkpoints via the Electron transcript store", async () => {
    await expect(getLocalSyncCheckpoint("conv-checkpoint")).resolves.toBeNull();

    await setLocalSyncCheckpoint("conv-checkpoint", "local-99");
    await expect(getLocalSyncCheckpoint("conv-checkpoint")).resolves.toBe("local-99");
    expect(window.electronAPI?.localChat.setSyncCheckpoint).toHaveBeenCalledWith({
      conversationId: "conv-checkpoint",
      localMessageId: "local-99",
    });
  });

  it("notifies subscribers from the Electron local chat update stream", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalChatUpdates(listener);

    await appendLocalEvent({
      conversationId: "conv-sub",
      type: "user_message",
      eventId: "sub-1",
      timestamp: 1,
      payload: { text: "hello" },
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    await appendLocalEvent({
      conversationId: "conv-sub",
      type: "assistant_message",
      eventId: "sub-2",
      timestamp: 2,
      payload: { text: "bye" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});


