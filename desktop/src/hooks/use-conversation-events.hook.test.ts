import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EventRecord } from "./use-conversation-events";

let mockStorageMode: "local" | "cloud" = "local";
const mockUseConvexAuth = vi.fn(() => ({
  isAuthenticated: true,
  isLoading: false,
}));
const mockUseQuery = vi.fn<(ref: unknown, args?: unknown) => unknown>(() => undefined);
const mockListLocalEvents = vi.fn<(conversationId: string, maxItems: number) => EventRecord[]>(() => []);
const mockUnsubscribe = vi.fn();
let localUpdateListener: (() => void) | null = null;
const mockSubscribeToLocalChatUpdates = vi.fn<(listener: () => void) => () => void>(
  (listener: () => void) => {
    localUpdateListener = listener;
    return mockUnsubscribe;
  },
);

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
  useQuery: (ref: unknown, args?: unknown) => mockUseQuery(ref, args),
}));

vi.mock("@/providers/chat-store", () => ({
  useChatStore: vi.fn(() => ({
    storageMode: mockStorageMode,
  })),
}));

vi.mock("@/services/local-chat-store", () => ({
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

import { useConversationEvents } from "./use-conversation-events";

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

describe("useConversationEvents hook behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageMode = "local";
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(undefined);
    mockListLocalEvents.mockReturnValue([]);
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

    const { result, unmount } = renderHook(() => useConversationEvents("conv-1"));

    expect(mockUseQuery).toHaveBeenCalledWith("events:listEvents", "skip");
    expect(mockListLocalEvents).toHaveBeenCalledWith("conv-1", 200);
    expect(mockSubscribeToLocalChatUpdates).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(initialEvents);

    act(() => {
      currentEvents = refreshedEvents;
      localUpdateListener?.();
    });

    expect(mockListLocalEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current).toEqual(refreshedEvents);

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("returns empty local events and skips subscription without a conversationId", () => {
    const { result } = renderHook(() => useConversationEvents(undefined));

    expect(result.current).toEqual([]);
    expect(mockListLocalEvents).not.toHaveBeenCalled();
    expect(mockSubscribeToLocalChatUpdates).not.toHaveBeenCalled();
  });

  it("uses cloud query results and returns events oldest-to-newest", () => {
    mockStorageMode = "cloud";
    mockUseQuery.mockReturnValue({
      page: [
        makeEvent("e-2", 2, "assistant_message", { text: "newest" }),
        makeEvent("e-1", 1, "user_message", { text: "oldest" }),
      ],
    });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    expect(mockUseQuery).toHaveBeenCalledWith("events:listEvents", {
      conversationId: "conv-1",
      paginationOpts: { cursor: null, numItems: 200 },
    });
    expect(mockListLocalEvents).not.toHaveBeenCalled();
    expect(mockSubscribeToLocalChatUpdates).not.toHaveBeenCalled();
    expect(result.current.map((event) => event._id)).toEqual(["e-1", "e-2"]);
  });


  it("cleans up local subscription when storage mode changes away from local", () => {
    mockStorageMode = "local";
    mockListLocalEvents.mockReturnValue([
      makeEvent("local-1", 1, "user_message", { text: "local" }),
    ]);
    mockUseQuery.mockReturnValue({
      page: [makeEvent("cloud-1", 2, "assistant_message", { text: "cloud" })],
    });

    const { result, rerender } = renderHook(() => useConversationEvents("conv-1"));
    expect(result.current.map((event) => event._id)).toEqual(["local-1"]);

    mockStorageMode = "cloud";
    rerender();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.map((event) => event._id)).toEqual(["cloud-1"]);
  });
});


