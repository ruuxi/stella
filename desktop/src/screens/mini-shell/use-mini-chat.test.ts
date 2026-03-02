import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the hook
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockCancelCurrentStream = vi.fn();
const mockResetStreamingState = vi.fn();

vi.mock("../../hooks/use-streaming-chat", () => ({
  useStreamingChat: vi.fn(() => ({
    streamingText: "",
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null,
    selfModMap: {},
    sendMessage: mockSendMessage,
    cancelCurrentStream: mockCancelCurrentStream,
    resetStreamingState: mockResetStreamingState,
  })),
}));

vi.mock("../../app/state/chat-store", () => ({
  useChatStore: vi.fn(() => ({
    storageMode: "cloud",
    isLocalStorage: false,
    cloudFeaturesEnabled: true,
    appendEvent: vi.fn(),
    appendAgentEvent: vi.fn(),
    uploadAttachments: vi.fn(),
    buildHistory: vi.fn(),
  })),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: true, isLoading: false })),
  useQuery: vi.fn(() => "connected"),
}));

let mockConversationId: string | null = "conv-123";

vi.mock("../../app/state/ui-state", () => ({
  useUiState: vi.fn(() => ({
    state: { get conversationId() { return mockConversationId; } },
  })),
}));

vi.mock("../../convex/api", () => ({
  api: {
    events: { appendEvent: "appendEvent", listEvents: "listEvents" },
    data: {
      attachments: { createFromDataUrl: "createFromDataUrl" },
      preferences: {
        getAccountMode: "getAccountMode",
        getSyncMode: "getSyncMode",
      },
    },
  },
}));

let mockEvents: import("../../hooks/use-conversation-events").EventRecord[] = [];

vi.mock("../../hooks/use-conversation-events", () => ({
  useConversationEvents: vi.fn(() => mockEvents),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useMiniChat } from "./use-mini-chat";
import { useStreamingChat } from "../../hooks/use-streaming-chat";
import { useConversationEvents } from "../../hooks/use-conversation-events";
import type { ChatContext } from "../../types/electron";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides?: Partial<Parameters<typeof useMiniChat>[0]>) {
  return {
    chatContext: null as ChatContext | null,
    selectedText: null as string | null,
    setChatContext: vi.fn(),
    setSelectedText: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("useMiniChat", () => {
  beforeEach(() => {
    mockConversationId = "conv-123";
    mockEvents = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // 1. Initial state
  // ----------------------------------------------------------------
  describe("initial state", () => {
    it("returns correct initial values", () => {
      const { result } = renderHook(() => useMiniChat(makeOpts()));

      expect(result.current.message).toBe("");
      expect(result.current.streamingText).toBe("");
      expect(result.current.reasoningText).toBe("");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.pendingUserMessageId).toBeNull();
      expect(result.current.expanded).toBe(false);
      expect(result.current.events).toEqual([]);
      expect(typeof result.current.sendMessage).toBe("function");
      expect(typeof result.current.setMessage).toBe("function");
      expect(typeof result.current.setExpanded).toBe("function");
    });

    it("setMessage updates message state", () => {
      const { result } = renderHook(() => useMiniChat(makeOpts()));

      act(() => {
        result.current.setMessage("hello");
      });

      expect(result.current.message).toBe("hello");
    });

    it("setExpanded updates expanded state", () => {
      const { result } = renderHook(() => useMiniChat(makeOpts()));

      act(() => {
        result.current.setExpanded(true);
      });

      expect(result.current.expanded).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 2. Events passthrough
  // ----------------------------------------------------------------
  describe("events passthrough", () => {
    it("returns events from useConversationEvents", () => {
      mockEvents = [
        { _id: "e1", type: "user_message", timestamp: 1, payload: { text: "hi" } },
        { _id: "e2", type: "assistant_message", timestamp: 2, payload: { text: "hello" } },
      ] as any;

      const { result } = renderHook(() => useMiniChat(makeOpts()));

      expect(result.current.events).toHaveLength(2);
    });

    it("passes conversationId to useConversationEvents", () => {
      renderHook(() => useMiniChat(makeOpts()));

      expect(vi.mocked(useConversationEvents)).toHaveBeenCalledWith(
        "conv-123",
      );
    });
  });

  // ----------------------------------------------------------------
  // 3. Passes events and conversationId to shared hook
  // ----------------------------------------------------------------
  describe("shared hook wiring", () => {
    it("passes conversationId and events to useStreamingChat", () => {
      mockEvents = [{ _id: "e1", type: "user_message", timestamp: 1 }] as any;

      renderHook(() => useMiniChat(makeOpts()));

      expect(vi.mocked(useStreamingChat)).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-123",
          events: mockEvents,
        }),
      );
    });

    it("passes null conversationId when not set", () => {
      mockConversationId = null;

      renderHook(() => useMiniChat(makeOpts()));

      expect(vi.mocked(useStreamingChat)).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: null }),
      );
    });
  });

  // ----------------------------------------------------------------
  // 4. sendMessage wrapper
  // ----------------------------------------------------------------
  describe("sendMessage wrapper", () => {
    it("calls shared sendMessage with current message, context, and onClear", async () => {
      const setChatContext = vi.fn();
      const setSelectedText = vi.fn();
      const chatContext: ChatContext = {
        window: { title: "Doc", app: "Code", bounds: { x: 0, y: 0, width: 100, height: 100 } },
      };
      const opts = makeOpts({ chatContext, selectedText: "selected", setChatContext, setSelectedText });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("my question");
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const args = mockSendMessage.mock.calls[0][0];
      expect(args.text).toBe("my question");
      expect(args.selectedText).toBe("selected");
      expect(args.chatContext).toBe(chatContext);
      expect(typeof args.onClear).toBe("function");
    });

    it("onClear clears message, selectedText, chatContext, and sets expanded", async () => {
      const setChatContext = vi.fn();
      const setSelectedText = vi.fn();
      const opts = makeOpts({ setChatContext, setSelectedText });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      // Extract and call onClear
      const args = mockSendMessage.mock.calls[0][0];
      act(() => {
        args.onClear();
      });

      expect(result.current.message).toBe("");
      expect(setSelectedText).toHaveBeenCalledWith(null);
      expect(setChatContext).toHaveBeenCalledWith(null);
      expect(result.current.expanded).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 5. Surfaces shared hook values
  // ----------------------------------------------------------------
  describe("surfaces shared hook values", () => {
    it("returns isStreaming from shared hook", () => {
      vi.mocked(useStreamingChat).mockReturnValue({
        streamingText: "hello",
        reasoningText: "thinking...",
        isStreaming: true,
        pendingUserMessageId: "msg-1",
        selfModMap: { "msg-1": { featureId: "f1", files: ["a.ts"], batchIndex: 0 } },
        sendMessage: mockSendMessage,
        cancelCurrentStream: mockCancelCurrentStream,
        resetStreamingState: mockResetStreamingState,
      });

      const { result } = renderHook(() => useMiniChat(makeOpts()));

      expect(result.current.streamingText).toBe("hello");
      expect(result.current.reasoningText).toBe("thinking...");
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.pendingUserMessageId).toBe("msg-1");
      expect(result.current.selfModMap).toEqual({
        "msg-1": { featureId: "f1", files: ["a.ts"], batchIndex: 0 },
      });
    });
  });
});
