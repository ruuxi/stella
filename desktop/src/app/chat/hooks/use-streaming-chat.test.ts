import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock external deps before importing the hook
vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: false, isLoading: false })),
  useQuery: vi.fn(),
  useMutation: vi.fn(() =>
    Object.assign(vi.fn(), {
      withOptimisticUpdate: vi.fn(() => vi.fn()),
    }),
  ),
  useAction: vi.fn(() => vi.fn()),
}));

vi.mock("@/platform/electron/device", () => ({
  getOrCreateDeviceId: vi.fn(() => Promise.resolve("device-1")),
}));

const mockAppendEvent = vi.fn(() => Promise.resolve(null));
const mockAppendAgentEvent = vi.fn();
const mockUploadAttachments = vi.fn(() => Promise.resolve([]));
const mockBuildHistory = vi.fn(() => undefined);

vi.mock("@/context/chat-store", () => ({
  useChatStore: vi.fn(() => ({
    storageMode: "cloud",
    isLocalStorage: false,
    cloudFeaturesEnabled: true,
    appendEvent: mockAppendEvent,
    appendAgentEvent: mockAppendAgentEvent,
    uploadAttachments: mockUploadAttachments,
    buildHistory: mockBuildHistory,
  })),
}));

vi.mock("./use-raf-state", async () => {
  const { useState, useRef, useCallback } = await import("react");
  return {
    useRafStringAccumulator: () => {
      const [text, setText] = useState("");
      const textRef = useRef("");
      const append = useCallback(
        (delta: string) => {
          textRef.current += delta;
          setText((prev: string) => prev + delta);
        },
        [setText],
      );
      const reset = useCallback(() => {
        textRef.current = "";
        setText("");
      }, [setText]);
      return [text, append, reset, textRef];
    },
  };
});

import { useStreamingChat } from "./use-streaming-chat";
import { getOrCreateDeviceId } from "@/platform/electron/device";
import type { EventRecord } from "./use-conversation-events";

// ----------------------------------------------------------------
// Helper: build an EventRecord
// ----------------------------------------------------------------
function makeEvent(
  overrides: Partial<EventRecord> & { _id: string; type: string },
): EventRecord {
  return {
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("useStreamingChat", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Initial state
  // ----------------------------------------------------------------
  describe("initial state", () => {
    it("returns correct initial values", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      expect(result.current.streamingText).toBe("");
      expect(result.current.reasoningText).toBe("");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.pendingUserMessageId).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Follow-up queue (via internal effect)
  // ----------------------------------------------------------------
  describe("follow-up queue processing", () => {
    it("does not start stream when no follow_up events exist", () => {
      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "hello", mode: "normal" },
        }),
      ];

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events }),
      );

      // No follow-up, so isStreaming stays false
      expect(result.current.isStreaming).toBe(false);
    });

    it("skips follow_up that already has an assistant response", async () => {
      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up question", mode: "follow_up" },
        }),
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "msg-1", text: "response" },
        }),
      ];

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isStreaming).toBe(false);
    });

    it("does nothing when conversationId is null", async () => {
      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up" },
        }),
      ];

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: null, events }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isStreaming).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // cancelCurrentStream
  // ----------------------------------------------------------------
  describe("cancelCurrentStream", () => {
    it("is callable and does not throw when nothing is streaming", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      expect(() => {
        act(() => {
          result.current.cancelCurrentStream();
        });
      }).not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // resetStreamingState
  // ----------------------------------------------------------------
  describe("resetStreamingState", () => {
    it("resets isStreaming", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      act(() => {
        result.current.resetStreamingState();
      });

      expect(result.current.isStreaming).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // sendMessage
  // ----------------------------------------------------------------
  describe("sendMessage", () => {
    it("does nothing when conversationId is null", async () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: null, events: [] }),
      );

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "hello",
          selectedText: null,
          chatContext: null,
          onClear,
        });
      });

      expect(onClear).not.toHaveBeenCalled();
      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
    });

    it("does nothing when text is empty and no context", async () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "   ",
          selectedText: null,
          chatContext: null,
          onClear,
        });
      });

      expect(onClear).not.toHaveBeenCalled();
      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
    });

    it("proceeds when text is empty but selectedText is present", async () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "",
          selectedText: "some selection",
          chatContext: null,
          onClear,
        });
      });

      expect(getOrCreateDeviceId).toHaveBeenCalled();
    });

    it("proceeds when text is empty but window context is present", async () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "",
          selectedText: null,
          chatContext: {
            window: {
              title: "My Window",
              app: "Code",
              bounds: { x: 0, y: 0, width: 100, height: 100 },
            },
          },
          onClear,
        });
      });

      expect(getOrCreateDeviceId).toHaveBeenCalled();
    });
  });
});


