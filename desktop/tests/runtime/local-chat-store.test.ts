import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import {
  __privateLocalChatStore,
  subscribeToLocalConversationEventWindow,
} from "@/app/chat/services/local-chat-store";
import type { LocalChatUpdatedPayload } from "../../../runtime/contracts/local-chat";

const event = (
  id: string,
  timestamp: number,
  type = "user_message",
  payload: Record<string, unknown> = { text: id },
): EventRecord => ({
  _id: id,
  timestamp,
  type,
  payload,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const stubLocalChatApi = (localChat: unknown) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      electronAPI: {
        localChat,
      },
    },
  });
};

describe("local-chat-store", () => {
  afterEach(() => {
    __privateLocalChatStore.resetForTests();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("loads the persisted window once and applies pushed events in memory", async () => {
    const updates = new Set<
      (payload: LocalChatUpdatedPayload | null) => void
    >();
    const listEvents = vi.fn().mockResolvedValue([event("1", 1)]);
    const getEventCount = vi.fn().mockResolvedValue(1);

    stubLocalChatApi({
      listEvents,
      getEventCount,
      onUpdated: (
        listener: (payload: LocalChatUpdatedPayload | null) => void,
      ) => {
        updates.add(listener);
        return () => updates.delete(listener);
      },
    });

    const snapshots: EventRecord[][] = [];
    const unsubscribe = subscribeToLocalConversationEventWindow(
      {
        conversationId: "conversation-1",
        maxItems: 10,
        windowBy: "visible_messages",
      },
      (snapshot) => {
        snapshots.push(snapshot.events);
      },
    );

    await flush();
    await flush();

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.map((item) => item._id)).toEqual(["1"]);

    for (const listener of updates) {
      listener({
        conversationId: "conversation-1",
        event: event("2", 2),
      });
    }

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.map((item) => item._id)).toEqual(["1", "2"]);

    unsubscribe();
  });

  it("keeps pushed events over an in-flight persisted load", async () => {
    const updates = new Set<
      (payload: LocalChatUpdatedPayload | null) => void
    >();
    let resolveList: ((events: EventRecord[]) => void) | undefined;
    const listEvents = vi.fn(
      () =>
        new Promise<EventRecord[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const getEventCount = vi.fn().mockResolvedValue(1);

    stubLocalChatApi({
      listEvents,
      getEventCount,
      onUpdated: (
        listener: (payload: LocalChatUpdatedPayload | null) => void,
      ) => {
        updates.add(listener);
        return () => updates.delete(listener);
      },
    });

    const snapshots: EventRecord[][] = [];
    subscribeToLocalConversationEventWindow(
      {
        conversationId: "conversation-1",
        maxItems: 10,
        windowBy: "visible_messages",
      },
      (snapshot) => {
        snapshots.push(snapshot.events);
      },
    );

    for (const listener of updates) {
      listener({
        conversationId: "conversation-1",
        event: event("2", 2),
      });
    }

    resolveList?.([event("1", 1)]);
    await flush();
    await flush();

    expect(snapshots.at(-1)?.map((item) => item._id)).toEqual(["1", "2"]);
  });

  it("caps pushed updates by the visible message window", async () => {
    const updates = new Set<
      (payload: LocalChatUpdatedPayload | null) => void
    >();
    const listEvents = vi
      .fn()
      .mockResolvedValue([event("1", 1), event("2", 2)]);
    const getEventCount = vi.fn().mockResolvedValue(2);

    stubLocalChatApi({
      listEvents,
      getEventCount,
      onUpdated: (
        listener: (payload: LocalChatUpdatedPayload | null) => void,
      ) => {
        updates.add(listener);
        return () => updates.delete(listener);
      },
    });

    const snapshots: EventRecord[][] = [];
    subscribeToLocalConversationEventWindow(
      {
        conversationId: "conversation-1",
        maxItems: 2,
        windowBy: "visible_messages",
      },
      (snapshot) => {
        snapshots.push(snapshot.events);
      },
    );

    await flush();
    await flush();

    for (const listener of updates) {
      listener({
        conversationId: "conversation-1",
        event: event("tool-1", 3, "tool_request", { toolName: "Read" }),
      });
      listener({
        conversationId: "conversation-1",
        event: event("3", 4),
      });
    }

    expect(snapshots.at(-1)?.map((item) => item._id)).toEqual([
      "2",
      "tool-1",
      "3",
    ]);
  });

  it("does not count persisted live events that fell outside the refreshed window", async () => {
    const updates = new Set<
      (payload: LocalChatUpdatedPayload | null) => void
    >();
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce([event("3", 3), event("4", 4)])
      .mockResolvedValueOnce([event("4", 4), event("5", 5)]);
    const getEventCount = vi.fn().mockResolvedValue(5);

    stubLocalChatApi({
      listEvents,
      getEventCount,
      onUpdated: (
        listener: (payload: LocalChatUpdatedPayload | null) => void,
      ) => {
        updates.add(listener);
        return () => updates.delete(listener);
      },
    });

    const counts: number[] = [];
    subscribeToLocalConversationEventWindow(
      {
        conversationId: "conversation-1",
        maxItems: 2,
        windowBy: "visible_messages",
      },
      (snapshot) => {
        counts.push(snapshot.count);
      },
    );

    await flush();
    await flush();

    for (const listener of updates) {
      listener({
        conversationId: "conversation-1",
        event: event("2", 2),
      });
      listener(null);
    }

    await flush();
    await flush();

    expect(counts.at(-1)).toBe(5);
  });
});
