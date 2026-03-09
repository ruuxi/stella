import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { EventRecord } from "../../../../../src/app/chat/lib/event-transforms";

let mockStorageMode: "local" | "cloud" = "local";
const mockUsePaginatedQuery = vi.fn<(ref: unknown, args?: unknown, options?: unknown) => unknown>(() => undefined);
const mockListLocalEvents = vi.fn<
  (conversationId: string, maxItems: number) => Promise<EventRecord[]>
>(() => Promise.resolve([]));
const mockGetLocalEventCount = vi.fn<(conversationId: string) => Promise<number>>(
  () => Promise.resolve(0),
);
const mockUnsubscribe = vi.fn();
let localUpdateListener: (() => void) | null = null;
const mockSubscribeToLocalChatUpdates = vi.fn<(listener: () => void) => () => void>(
  (listener: () => void) => {
    localUpdateListener = listener;
    return mockUnsubscribe;
  },
);
const mockScheduleListConversationEvents = vi.fn<
  (payload: { conversationId: string; maxItems?: number }) => Promise<EventRecord[]>
>(() => Promise.resolve([]));
const mockScheduleGetConversationEventCount = vi.fn<
  (payload: { conversationId: string }) => Promise<number>
>(() => Promise.resolve(0));
const mockScheduleUnsubscribe = vi.fn();

vi.mock("convex/react", () => ({
  usePaginatedQuery: (ref: unknown, args?: unknown, options?: unknown) =>
    mockUsePaginatedQuery(ref, args, options),
}));

vi.mock("@/context/chat-store", () => ({
  useChatStore: vi.fn(() => ({
    storageMode: mockStorageMode,
  })),
}));

vi.mock("@/app/chat/services/local-chat-store", () => ({
  getLocalEventCount: (conversationId: string) => mockGetLocalEventCount(conversationId),
  listLocalEvents: (conversationId: string, maxItems: number) =>
    mockListLocalEvents(conversationId, maxItems),
  subscribeToLocalChatUpdates: (listener: () => void) =>
    mockSubscribeToLocalChatUpdates(listener),
}));

vi.mock("@/convex/api", () => ({
  api: {
    events: {
      listEvents: "events:listEvents",
    },
  },
}));

import {
  useConversationEventFeed,
  useConversationEvents,
} from "../../../../../src/app/chat/hooks/use-conversation-events";

const makeEvent = (
  id: string,
  timestamp: number,
  type: string,
  payload?: Record<string, unknown>,
): EventRecord => ({
  _id: id,
  timestamp,
  type,
  ...(payload ? { payload } : {}),
});

async function waitForScheduleRefresh(
  conversationId: string,
  maxItems = 200,
) {
  await waitFor(() => {
    expect(mockScheduleListConversationEvents).toHaveBeenLastCalledWith({
      conversationId,
      maxItems,
    });
    expect(mockScheduleGetConversationEventCount).toHaveBeenLastCalledWith({
      conversationId,
    });
  });
}

describe("useConversationEventFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageMode = "local";
    mockUsePaginatedQuery.mockReturnValue(undefined);
    mockListLocalEvents.mockResolvedValue([]);
    mockGetLocalEventCount.mockResolvedValue(0);
    mockScheduleListConversationEvents.mockResolvedValue([]);
    mockScheduleGetConversationEventCount.mockResolvedValue(0);
    localUpdateListener = null;
    window.electronAPI = {
      schedule: {
        listCronJobs: vi.fn(),
        listHeartbeats: vi.fn(),
        listConversationEvents: (payload: { conversationId: string; maxItems?: number }) =>
          mockScheduleListConversationEvents(payload),
        getConversationEventCount: (payload: { conversationId: string }) =>
          mockScheduleGetConversationEventCount(payload),
        onUpdated: (callback: () => void) => {
          void callback;
          return mockScheduleUnsubscribe;
        },
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates local events and refreshes when local chat updates fire", async () => {
    const initialEvents = [
      makeEvent("e-1", 1, "user_message", { text: "hello" }),
    ];
    const refreshedEvents = [
      ...initialEvents,
      makeEvent("e-2", 2, "assistant_message", { text: "hi" }),
    ];
    let currentEvents = initialEvents;
    mockListLocalEvents.mockImplementation(async () => currentEvents);
    mockGetLocalEventCount.mockResolvedValue(refreshedEvents.length);

    const { result, unmount } = renderHook(() => useConversationEventFeed("conv-1"));

    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      "events:listEvents",
      "skip",
      { initialNumItems: 200 },
    );
    await waitFor(() => {
      expect(mockListLocalEvents).toHaveBeenCalledWith("conv-1", 200);
      expect(mockSubscribeToLocalChatUpdates).toHaveBeenCalledTimes(1);
      expect(result.current.events).toEqual(initialEvents);
    });

    act(() => {
      currentEvents = refreshedEvents;
      localUpdateListener?.();
    });

    await waitFor(() => {
      expect(mockListLocalEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.current.events).toEqual(refreshedEvents);
    });

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("expands the local window when loading older history", async () => {
    const allEvents = Array.from({ length: 400 }, (_, index) =>
      makeEvent(
        `e-${index + 1}`,
        index + 1,
        index % 2 === 0 ? "user_message" : "assistant_message",
        { text: `event ${index + 1}` },
      ),
    );

    mockListLocalEvents.mockImplementation(async (_conversationId, maxItems) =>
      allEvents.slice(Math.max(0, allEvents.length - maxItems)),
    );
    mockGetLocalEventCount.mockResolvedValue(allEvents.length);

    const { result } = renderHook(() => useConversationEventFeed("conv-1"));

    await waitForScheduleRefresh("conv-1");

    expect(result.current.events).toHaveLength(200);
    expect(result.current.hasOlderEvents).toBe(true);

    act(() => {
      result.current.loadOlder();
    });

    await waitForScheduleRefresh("conv-1", 400);

    expect(mockListLocalEvents).toHaveBeenLastCalledWith("conv-1", 400);
    expect(result.current.events).toHaveLength(400);
    expect(result.current.hasOlderEvents).toBe(false);
  });

  it("merges local scheduler events into the local event feed", async () => {
    mockListLocalEvents.mockResolvedValue([
      makeEvent("e-1", 1, "user_message", { text: "hello" }),
    ]);
    mockGetLocalEventCount.mockResolvedValue(1);
    mockScheduleListConversationEvents.mockResolvedValue([
      makeEvent("e-2", 2, "assistant_message", {
        text: "Scheduled reply",
        source: "cron",
      }),
    ]);
    mockScheduleGetConversationEventCount.mockResolvedValue(1);

    const { result } = renderHook(() => useConversationEventFeed("conv-1"));

    await waitFor(() => {
      expect(result.current.events.map((event) => event._id)).toEqual(["e-1", "e-2"]);
    });

    expect(mockScheduleListConversationEvents).toHaveBeenCalledWith({
      conversationId: "conv-1",
      maxItems: 200,
    });
    expect(mockScheduleGetConversationEventCount).toHaveBeenCalledWith({
      conversationId: "conv-1",
    });
  });

  it("retries local event loading after a transient startup failure", async () => {
    const recoveredEvents = [
      makeEvent("e-1", 1, "user_message", { text: "hello again" }),
    ];
    let shouldFail = true;

    mockListLocalEvents.mockImplementation(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("local chat not ready");
      }
      return recoveredEvents;
    });
    mockGetLocalEventCount.mockResolvedValue(recoveredEvents.length);

    const { result } = renderHook(() => useConversationEventFeed("conv-1"));

    await waitFor(() => {
      expect(mockListLocalEvents).toHaveBeenCalledWith("conv-1", 200);
      expect(result.current.isInitialLoading).toBe(true);
      expect(result.current.events).toEqual([]);
    });

    await waitFor(() => {
      expect(mockListLocalEvents).toHaveBeenCalledTimes(2);
      expect(result.current.events).toEqual(recoveredEvents);
      expect(result.current.isInitialLoading).toBe(false);
    }, { timeout: 2_000 });
  });

  it("resets the local window when the conversation changes", async () => {
    const eventsByConversation = {
      "conv-1": Array.from({ length: 400 }, (_, index) =>
        makeEvent(
          `conv-1-${index + 1}`,
          index + 1,
          index % 2 === 0 ? "user_message" : "assistant_message",
          { text: `conv-1 event ${index + 1}` },
        ),
      ),
      "conv-2": Array.from({ length: 50 }, (_, index) =>
        makeEvent(
          `conv-2-${index + 1}`,
          index + 1,
          index % 2 === 0 ? "user_message" : "assistant_message",
          { text: `conv-2 event ${index + 1}` },
        ),
      ),
    } satisfies Record<string, EventRecord[]>;

    mockListLocalEvents.mockImplementation(async (conversationId, maxItems) => {
      const events = eventsByConversation[conversationId as keyof typeof eventsByConversation] ?? [];
      return events.slice(Math.max(0, events.length - maxItems));
    });
    mockGetLocalEventCount.mockImplementation(
      async (conversationId) =>
        eventsByConversation[conversationId as keyof typeof eventsByConversation]?.length ?? 0,
    );

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId?: string }) =>
        useConversationEventFeed(conversationId),
      {
        initialProps: { conversationId: "conv-1" },
      },
    );

    await waitForScheduleRefresh("conv-1");

    expect(result.current.events).toHaveLength(200);

    act(() => {
      result.current.loadOlder();
    });

    await waitForScheduleRefresh("conv-1", 400);
    expect(result.current.events).toHaveLength(400);

    rerender({ conversationId: "conv-2" });
    await waitForScheduleRefresh("conv-2");
    expect(result.current.events).toHaveLength(50);

    rerender({ conversationId: "conv-1" });
    await waitForScheduleRefresh("conv-1");
    expect(result.current.events).toHaveLength(200);
    expect(mockListLocalEvents).toHaveBeenLastCalledWith("conv-1", 200);
  });

  it("uses cloud pagination results, exposes loading state, and requests older history", () => {
    mockStorageMode = "cloud";
    const loadMore = vi.fn();
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        makeEvent("e-2", 2, "assistant_message", { text: "newest" }),
        makeEvent("e-1", 1, "user_message", { text: "oldest" }),
      ],
      status: "CanLoadMore",
      loadMore,
    });

    const { result } = renderHook(() => useConversationEventFeed("conv-1"));

    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      "events:listEvents",
      { conversationId: "conv-1" },
      { initialNumItems: 200 },
    );
    expect(result.current.events.map((event) => event._id)).toEqual(["e-1", "e-2"]);
    expect(result.current.hasOlderEvents).toBe(true);
    expect(result.current.isInitialLoading).toBe(false);

    act(() => {
      result.current.loadOlder();
    });

    expect(loadMore).toHaveBeenCalledWith(200);
  });

  it("marks the first cloud page as loading without showing an empty conversation state downstream", () => {
    mockStorageMode = "cloud";
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: "LoadingFirstPage",
      loadMore: vi.fn(),
    });

    const { result } = renderHook(() => useConversationEventFeed("conv-1"));

    expect(result.current.events).toEqual([]);
    expect(result.current.isInitialLoading).toBe(true);
    expect(result.current.hasOlderEvents).toBe(false);
  });
});

describe("useConversationEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageMode = "cloud";
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        makeEvent("e-3", 3, "assistant_message", { text: "newest" }),
        makeEvent("e-2", 2, "user_message", { text: "middle" }),
        makeEvent("e-1", 1, "assistant_message", { text: "oldest" }),
      ],
      status: "Exhausted",
      loadMore: vi.fn(),
    });
  });

  it("preserves the simple array API for existing consumers", () => {
    const { result } = renderHook(() => useConversationEvents("conv-1"));

    expect(result.current.map((event) => event._id)).toEqual([
      "e-1",
      "e-2",
      "e-3",
    ]);
  });
});
