import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EventRecord } from "./use-conversation-events";

let mockStorageMode: "local" | "cloud" = "local";
const mockUsePaginatedQuery = vi.fn<(ref: unknown, args?: unknown, options?: unknown) => unknown>(() => undefined);
const mockListLocalEvents = vi.fn<(conversationId: string, maxItems: number) => EventRecord[]>(() => []);
const mockGetLocalEventCount = vi.fn<(conversationId: string) => number>(() => 0);
const mockUnsubscribe = vi.fn();
let localUpdateListener: (() => void) | null = null;
const mockSubscribeToLocalChatUpdates = vi.fn<(listener: () => void) => () => void>(
  (listener: () => void) => {
    localUpdateListener = listener;
    return mockUnsubscribe;
  },
);

vi.mock("convex/react", () => ({
  usePaginatedQuery: (ref: unknown, args?: unknown, options?: unknown) =>
    mockUsePaginatedQuery(ref, args, options),
}));

vi.mock("@/providers/chat-store", () => ({
  useChatStore: vi.fn(() => ({
    storageMode: mockStorageMode,
  })),
}));

vi.mock("@/services/local-chat-store", () => ({
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
} from "./use-conversation-events";

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

describe("useConversationEventFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageMode = "local";
    mockUsePaginatedQuery.mockReturnValue(undefined);
    mockListLocalEvents.mockReturnValue([]);
    mockGetLocalEventCount.mockReturnValue(0);
    localUpdateListener = null;
  });

  it("hydrates local events and refreshes when local chat updates fire", () => {
    const initialEvents = [
      makeEvent("e-1", 1, "user_message", { text: "hello" }),
    ];
    const refreshedEvents = [
      ...initialEvents,
      makeEvent("e-2", 2, "assistant_message", { text: "hi" }),
    ];
    let currentEvents = initialEvents;
    mockListLocalEvents.mockImplementation(() => currentEvents);
    mockGetLocalEventCount.mockReturnValue(refreshedEvents.length);

    const { result, unmount } = renderHook(() => useConversationEventFeed("conv-1"));

    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      "events:listEvents",
      "skip",
      { initialNumItems: 200 },
    );
    expect(mockListLocalEvents).toHaveBeenCalledWith("conv-1", 200);
    expect(mockSubscribeToLocalChatUpdates).toHaveBeenCalledTimes(1);
    expect(result.current.events).toEqual(initialEvents);

    act(() => {
      currentEvents = refreshedEvents;
      localUpdateListener?.();
    });

    expect(mockListLocalEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.events).toEqual(refreshedEvents);

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("expands the local window when loading older history", () => {
    const allEvents = Array.from({ length: 400 }, (_, index) =>
      makeEvent(
        `e-${index + 1}`,
        index + 1,
        index % 2 === 0 ? "user_message" : "assistant_message",
        { text: `event ${index + 1}` },
      ),
    );

    mockListLocalEvents.mockImplementation((_conversationId, maxItems) =>
      allEvents.slice(Math.max(0, allEvents.length - maxItems)),
    );
    mockGetLocalEventCount.mockReturnValue(allEvents.length);

    const { result } = renderHook(() => useConversationEventFeed("conv-1"));

    expect(result.current.events).toHaveLength(200);
    expect(result.current.hasOlderEvents).toBe(true);

    act(() => {
      result.current.loadOlder();
    });

    expect(mockListLocalEvents).toHaveBeenLastCalledWith("conv-1", 400);
    expect(result.current.events).toHaveLength(400);
    expect(result.current.hasOlderEvents).toBe(false);
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
