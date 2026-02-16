import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock external deps before importing the hook
vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(),
  useQuery: vi.fn(),
  useMutation: vi.fn(() =>
    Object.assign(vi.fn(), {
      withOptimisticUpdate: vi.fn(() => vi.fn()),
    }),
  ),
  useAction: vi.fn(() => vi.fn()),
}));

vi.mock("../../services/model-gateway", () => ({
  streamChat: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/device", () => ({
  getOrCreateDeviceId: vi.fn(() => Promise.resolve("device-1")),
}));

vi.mock("../../hooks/use-raf-state", async () => {
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
import { streamChat } from "../../services/model-gateway";
import { getOrCreateDeviceId } from "../../services/device";
import type { EventRecord } from "../../hooks/use-conversation-events";

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

  const flushRaf = () => {
    const callbacks = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of callbacks) cb(performance.now());
  };

  // ----------------------------------------------------------------
  // Initial state
  // ----------------------------------------------------------------
  describe("initial state", () => {
    it("returns correct initial values", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      expect(result.current.streamingText).toBe("");
      expect(result.current.reasoningText).toBe("");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.pendingUserMessageId).toBeNull();
      expect(result.current.queueNext).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // findQueuedFollowUp (pure logic)
  // ----------------------------------------------------------------
  describe("findQueuedFollowUp (via processFollowUpQueue behavior)", () => {
    it("returns null via processFollowUpQueue when no follow_up events exist", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "hello", mode: "normal" },
        }),
      ];

      // processFollowUpQueue won't start a stream because there is no queued follow-up
      act(() => {
        result.current.processFollowUpQueue(events);
      });

      // streamChat should NOT have been called
      expect(streamChat).not.toHaveBeenCalled();
    });

    it("detects an unresponded follow_up user_message and starts stream", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up question", mode: "follow_up" },
        }),
      ];

      act(() => {
        result.current.processFollowUpQueue(events);
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
    });

    it("skips follow_up that already has an assistant response", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

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

      act(() => {
        result.current.processFollowUpQueue(events);
      });

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("picks the first unresponded follow_up", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "first follow up", mode: "follow_up" },
        }),
        makeEvent({
          _id: "msg-2",
          type: "user_message",
          payload: {
            text: "second follow up",
            mode: "follow_up",
            attachments: [{ id: "att-1" }],
          },
        }),
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "msg-1", text: "response" },
        }),
      ];

      act(() => {
        result.current.processFollowUpQueue(events);
      });

      // Should stream for msg-2 (msg-1 is already responded)
      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({ userMessageId: "msg-2" }),
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  // ----------------------------------------------------------------
  // cancelCurrentStream
  // ----------------------------------------------------------------
  describe("cancelCurrentStream", () => {
    it("is callable and does not throw when nothing is streaming", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
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
    it("resets isStreaming and queueNext", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      act(() => {
        result.current.setQueueNext(true);
      });
      expect(result.current.queueNext).toBe(true);

      act(() => {
        result.current.resetStreamingState();
      });
      flushRaf();

      expect(result.current.queueNext).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // syncWithEvents
  // ----------------------------------------------------------------
  describe("syncWithEvents", () => {
    it("does nothing when pendingUserMessageId is null", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      // pendingUserMessageId is null by default
      const events: EventRecord[] = [
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "msg-1", text: "hello" },
        }),
      ];

      // Should not throw, and state should remain unchanged
      act(() => {
        result.current.syncWithEvents(events);
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
        useStreamingChat({ conversationId: null }),
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
        useStreamingChat({ conversationId: "conv-1" }),
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
        useStreamingChat({ conversationId: "conv-1" }),
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

      // getOrCreateDeviceId should have been called, meaning the guard passed
      expect(getOrCreateDeviceId).toHaveBeenCalled();
    });

    it("proceeds when text is empty but window context is present", async () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
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

    it("strips /followup prefix from message text", async () => {
      // We can test that the regex logic works by verifying the function
      // does not reject the message when the prefix is removed to leave content
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "/followup some text",
          selectedText: null,
          chatContext: null,
          onClear,
        });
      });

      expect(getOrCreateDeviceId).toHaveBeenCalled();
    });

    it("strips /queue prefix from message text", async () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "/queue my queued message",
          selectedText: null,
          chatContext: null,
          onClear,
        });
      });

      expect(getOrCreateDeviceId).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // setQueueNext
  // ----------------------------------------------------------------
  describe("setQueueNext", () => {
    it("toggles the queueNext state", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1" }),
      );

      expect(result.current.queueNext).toBe(false);

      act(() => {
        result.current.setQueueNext(true);
      });

      expect(result.current.queueNext).toBe(true);

      act(() => {
        result.current.setQueueNext(false);
      });

      expect(result.current.queueNext).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // processFollowUpQueue guards
  // ----------------------------------------------------------------
  describe("processFollowUpQueue guards", () => {
    it("does nothing when conversationId is null", () => {
      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: null }),
      );

      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up" },
        }),
      ];

      act(() => {
        result.current.processFollowUpQueue(events);
      });

      expect(streamChat).not.toHaveBeenCalled();
    });
  });
});
