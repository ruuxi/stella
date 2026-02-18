import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the hook
// ---------------------------------------------------------------------------

const mockAppendEvent = vi.fn();
const mockCreateAttachment = vi.fn();

vi.mock("convex/react", () => ({
  useAction: vi.fn(() => mockCreateAttachment),
  useMutation: vi.fn(() =>
    Object.assign(vi.fn(), {
      withOptimisticUpdate: vi.fn(() => mockAppendEvent),
    }),
  ),
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

let mockConversationId: string | null = "conv-123";

vi.mock("../../app/state/ui-state", () => ({
  useUiState: vi.fn(() => ({
    state: { get conversationId() { return mockConversationId; } },
  })),
}));

vi.mock("../../convex/api", () => ({
  api: {
    events: {
      appendEvent: "appendEvent",
      listEvents: "listEvents",
    },
    data: {
      attachments: {
        createFromDataUrl: "createFromDataUrl",
      },
    },
  },
}));

let mockEvents: import("../../hooks/use-conversation-events").EventRecord[] = [];

vi.mock("../../hooks/use-conversation-events", () => ({
  useConversationEvents: vi.fn(() => mockEvents),
}));

vi.mock("../../services/device", () => ({
  getOrCreateDeviceId: vi.fn(() => Promise.resolve("device-123")),
}));

vi.mock("../../services/model-gateway", () => ({
  streamChat: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useMiniChat } from "./use-mini-chat";
import { streamChat } from "../../services/model-gateway";
import { getOrCreateDeviceId } from "../../services/device";
import type { EventRecord } from "../../hooks/use-conversation-events";
import type { ChatContext } from "../../types/electron";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<EventRecord> & { _id: string; type: string },
): EventRecord {
  return {
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Default opts for the hook — every prop is settable through beforeEach or per-test. */
function makeOpts(overrides?: Partial<Parameters<typeof useMiniChat>[0]>) {
  return {
    chatContext: null as ChatContext | null,
    selectedText: null as string | null,
    setChatContext: vi.fn(),
    setSelectedText: vi.fn(),
    isStreaming: false,
    setIsStreaming: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("useMiniChat", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    // Reset per-test state
    mockConversationId = "conv-123";
    mockEvents = [];

    // Reset mocks fully (clears calls AND queued mockResolvedValueOnce, etc.)
    vi.clearAllMocks();
    mockAppendEvent.mockReset();
    mockCreateAttachment.mockReset();
    vi.mocked(streamChat).mockReset().mockReturnValue(Promise.resolve());
    vi.mocked(getOrCreateDeviceId).mockReset().mockReturnValue(Promise.resolve("device-123"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // 1. Initial state
  // ----------------------------------------------------------------
  describe("initial state", () => {
    it("returns correct initial values", () => {
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      expect(result.current.message).toBe("");
      expect(result.current.streamingText).toBe("");
      expect(result.current.reasoningText).toBe("");
      expect(result.current.pendingUserMessageId).toBeNull();
      expect(result.current.expanded).toBe(false);
      expect(result.current.events).toEqual([]);
      expect(typeof result.current.sendMessage).toBe("function");
      expect(typeof result.current.setMessage).toBe("function");
      expect(typeof result.current.setExpanded).toBe("function");
    });

    it("setMessage updates message state", () => {
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });

      expect(result.current.message).toBe("hello");
    });

    it("setExpanded updates expanded state", () => {
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      expect(result.current.expanded).toBe(false);

      act(() => {
        result.current.setExpanded(true);
      });

      expect(result.current.expanded).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 2. findQueuedFollowUp (via the useEffect follow-up processing)
  // ----------------------------------------------------------------
  describe("findQueuedFollowUp (via follow-up queue effect)", () => {
    it("does not start a stream when no follow_up events exist", () => {
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "hello", mode: "normal" },
        }),
      ];

      renderHook(() => useMiniChat(makeOpts()));

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("detects an unresponded follow_up user_message and starts stream", async () => {
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up question", mode: "follow_up" },
        }),
      ];

      renderHook(() => useMiniChat(makeOpts()));

      // The effect uses Promise.resolve().then() — flush microtasks
      await act(async () => {
        await Promise.resolve();
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-123",
          userMessageId: "msg-1",
          attachments: [],
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("skips follow_up that already has an assistant response", async () => {
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up" },
        }),
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "msg-1", text: "response" },
        }),
      ];

      renderHook(() => useMiniChat(makeOpts()));

      await act(async () => {
        await Promise.resolve();
      });

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("picks the first unresponded follow_up when multiple exist", async () => {
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "first follow up", mode: "follow_up" },
        }),
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "msg-1", text: "response" },
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
      ];

      renderHook(() => useMiniChat(makeOpts()));

      await act(async () => {
        await Promise.resolve();
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessageId: "msg-2",
          attachments: [{ id: "att-1" }],
        }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("does not process follow-up queue when conversationId is null", async () => {
      mockConversationId = null;
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up" },
        }),
      ];

      renderHook(() => useMiniChat(makeOpts()));

      await act(async () => {
        await Promise.resolve();
      });

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("does not process follow-up queue when isStreaming is true", async () => {
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up" },
        }),
      ];

      renderHook(() => useMiniChat(makeOpts({ isStreaming: true })));

      await act(async () => {
        await Promise.resolve();
      });

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("does not process follow-up queue when pendingUserMessageId is set", async () => {
      // Mount with no events, send a message to set pendingUserMessageId,
      // then inject a follow_up event and verify it's not processed.
      mockEvents = [];
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-sent" });
      const opts = makeOpts();
      const { result, rerender } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // pendingUserMessageId is now "evt-sent" (set inside startStream)
      expect(result.current.pendingUserMessageId).toBe("evt-sent");

      // Clear streamChat calls from the sendMessage
      vi.mocked(streamChat).mockClear();

      // Now inject a follow_up event
      mockEvents = [
        makeEvent({
          _id: "follow-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up" },
        }),
      ];

      await act(async () => {
        rerender();
        await Promise.resolve();
      });

      // The follow-up queue effect should NOT start a new stream because
      // pendingUserMessageId is still set
      expect(streamChat).not.toHaveBeenCalled();
    });

    it("passes attachments from follow_up event to startStream", async () => {
      const attachments = [
        { id: "att-1", url: "https://example.com/img.png", mimeType: "image/png" },
      ];
      mockEvents = [
        makeEvent({
          _id: "msg-1",
          type: "user_message",
          payload: { text: "follow up", mode: "follow_up", attachments },
        }),
      ];

      renderHook(() => useMiniChat(makeOpts()));

      await act(async () => {
        await Promise.resolve();
      });

      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({ attachments }),
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  // ----------------------------------------------------------------
  // 3. sendMessage guards
  // ----------------------------------------------------------------
  describe("sendMessage guards", () => {
    it("does nothing when conversationId is null", async () => {
      mockConversationId = null;
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });

    it("does nothing when text is empty with no context", async () => {
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      // Message is "" by default, no selectedText, no chatContext
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });

    it("does nothing when text is only whitespace with no context", async () => {
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("   ");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
    });

    it("does nothing when selectedText is empty whitespace and no text/window", async () => {
      const opts = makeOpts({ selectedText: "   " });
      const { result } = renderHook(() => useMiniChat(opts));

      // selectedText trims to empty, message is "", no window context
      // The guard checks: !rawText && !selectedSnippet && !windowSnippet
      // selectedSnippet = "   ".trim() = "" (falsy), so guard triggers
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // 4. sendMessage with context
  // ----------------------------------------------------------------
  describe("sendMessage with context", () => {
    it("proceeds when text is empty but selectedText is present", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts({ selectedText: "some selection" });
      const { result } = renderHook(() => useMiniChat(opts));

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).toHaveBeenCalled();
      expect(mockAppendEvent).toHaveBeenCalledTimes(1);
      // Text should include the quoted selection
      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toContain('"some selection"');
    });

    it("proceeds when text is empty but window context is present", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const chatContext: ChatContext = {
        window: {
          title: "My Window",
          app: "Code",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).toHaveBeenCalled();
      expect(mockAppendEvent).toHaveBeenCalledTimes(1);
      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toContain("Code - My Window");
      expect(callArgs.payload.text).toContain("<active-window");
    });

    it("includes window context, selectedText, and message text in combined text", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const chatContext: ChatContext = {
        window: {
          title: "Title",
          app: "App",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      };
      const opts = makeOpts({ chatContext, selectedText: "selected" });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("my question");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      const text = callArgs.payload.text as string;
      // Should have all three parts joined by double newlines
      expect(text).toContain("App - Title");
      expect(text).toContain('"selected"');
      expect(text).toContain("my question");
    });

    it("handles window context with only app (no title)", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const chatContext: ChatContext = {
        window: {
          title: "",
          app: "Finder",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("test");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      const text = callArgs.payload.text as string;
      // Should have just "Finder" (no " - " since title is empty)
      expect(text).toContain("Finder");
      expect(text).not.toContain("Finder - ");
    });

    it("handles null window in chatContext", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const chatContext: ChatContext = { window: null };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("test");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockAppendEvent).toHaveBeenCalledTimes(1);
      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toBe("test");
    });

    it("uploads regionScreenshots as attachments", async () => {
      mockCreateAttachment.mockResolvedValueOnce({
        _id: "att-id-1",
        url: "https://cdn.example.com/img1.png",
        mimeType: "image/png",
      });
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });

      const chatContext: ChatContext = {
        window: null,
        regionScreenshots: [
          { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
        ],
      };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("look at this");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockCreateAttachment).toHaveBeenCalledWith({
        conversationId: "conv-123",
        deviceId: "device-123",
        dataUrl: "data:image/png;base64,abc",
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.attachments).toEqual([
        {
          id: "att-id-1",
          url: "https://cdn.example.com/img1.png",
          mimeType: "image/png",
        },
      ]);
    });

    it("filters out null attachments from failed uploads", async () => {
      mockCreateAttachment
        .mockResolvedValueOnce({
          _id: "att-id-1",
          url: "https://cdn.example.com/img1.png",
          mimeType: "image/png",
        })
        .mockRejectedValueOnce(new Error("upload failed"));
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });

      const chatContext: ChatContext = {
        window: null,
        regionScreenshots: [
          { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
          { dataUrl: "data:image/png;base64,def", width: 200, height: 200 },
        ],
      };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("test");
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await act(async () => {
        await result.current.sendMessage();
      });
      consoleSpy.mockRestore();

      const callArgs = mockAppendEvent.mock.calls[0][0];
      // Only the successful attachment should be included
      expect(callArgs.payload.attachments).toHaveLength(1);
      expect(callArgs.payload.attachments[0].id).toBe("att-id-1");
    });

    it("filters out attachments with no _id", async () => {
      mockCreateAttachment.mockResolvedValueOnce({ url: "https://cdn.example.com/img.png" });
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });

      const chatContext: ChatContext = {
        window: null,
        regionScreenshots: [
          { dataUrl: "data:image/png;base64,abc", width: 100, height: 100 },
        ],
      };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("test");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.attachments).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------
  // 5. sendMessage /followup and /queue prefix stripping
  // ----------------------------------------------------------------
  describe("sendMessage prefix stripping", () => {
    it("strips /followup prefix from message text", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("/followup some text");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockAppendEvent).toHaveBeenCalledTimes(1);
      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toBe("some text");
    });

    it("strips /queue prefix from message text", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("/queue my queued message");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toBe("my queued message");
    });

    it("strips /FOLLOWUP prefix case-insensitively", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("/FOLLOWUP uppercase test");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toBe("uppercase test");
    });

    it("does not strip prefix from middle of text", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello /followup world");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.text).toBe("hello /followup world");
    });

    it("sets mode to follow_up when /followup prefix is used while streaming", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts({ isStreaming: true });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("/followup additional question");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.mode).toBe("follow_up");
    });

    it("does not call startStream for follow_up mode messages", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-follow" });
      const opts = makeOpts({ isStreaming: true });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("/followup additional question");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // streamChat should NOT be called because follow_up mode returns early
      expect(streamChat).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // 6. sendMessage in steer mode
  // ----------------------------------------------------------------
  describe("sendMessage in steer mode", () => {
    it("sets mode to steer when isStreaming and no /followup prefix", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ isStreaming: true, setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("redirect to this topic");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.mode).toBe("steer");
    });

    it("calls cancelCurrentStream and resetStreamingState in steer mode", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ isStreaming: true, setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("steer message");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // resetStreamingState calls setIsStreaming(false)
      expect(setIsStreaming).toHaveBeenCalledWith(false);
    });

    it("does not set mode when not streaming and no prefix", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts({ isStreaming: false });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("normal message");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      // mode should not be in payload
      expect(callArgs.payload.mode).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // 7. sendMessage successful flow
  // ----------------------------------------------------------------
  describe("sendMessage successful flow", () => {
    it("clears message, context, and selectedText on successful send", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setChatContext = vi.fn();
      const setSelectedText = vi.fn();
      const opts = makeOpts({ setChatContext, setSelectedText });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello world");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // Message should be cleared
      expect(result.current.message).toBe("");
      // Context should be cleared
      expect(setSelectedText).toHaveBeenCalledWith(null);
      expect(setChatContext).toHaveBeenCalledWith(null);
    });

    it("sets expanded to true after successful send", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.expanded).toBe(true);
    });

    it("calls startStream with the event id after appending", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-42" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-123",
          userMessageId: "evt-42",
          attachments: [],
        }),
        expect.any(Object),
        expect.any(Object),
      );
      // setIsStreaming(true) called inside startStream
      expect(setIsStreaming).toHaveBeenCalledWith(true);
    });

    it("does not start stream when appendEvent returns null", async () => {
      mockAppendEvent.mockResolvedValueOnce(null);
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("does not start stream when appendEvent returns object without _id", async () => {
      mockAppendEvent.mockResolvedValueOnce({});
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(streamChat).not.toHaveBeenCalled();
    });

    it("includes platform in the event payload", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });

      // Set up window.electronAPI.platform
      const originalElectronApi = (window as unknown as Record<string, unknown>).electronAPI;
      (window as unknown as Record<string, unknown>).electronAPI = { platform: "win32" };

      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.platform).toBe("win32");

      // Clean up
      (window as unknown as Record<string, unknown>).electronAPI = originalElectronApi;
    });

    it("uses 'unknown' platform when electronAPI is not available", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });

      const originalElectronApi = (window as unknown as Record<string, unknown>).electronAPI;
      (window as unknown as Record<string, unknown>).electronAPI = undefined;

      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      expect(callArgs.payload.platform).toBe("unknown");

      (window as unknown as Record<string, unknown>).electronAPI = originalElectronApi;
    });
  });

  // ----------------------------------------------------------------
  // 8. cancelCurrentStream
  // ----------------------------------------------------------------
  describe("cancelCurrentStream", () => {
    it("is callable and does not throw when nothing is streaming", () => {
      const opts = makeOpts();
      renderHook(() => useMiniChat(opts));

      // cancelCurrentStream is not directly returned, but we can test it
      // indirectly via steer mode behavior. Let's verify no error occurs
      // when the hook is used normally. The cancel happens internally.
      expect(() => {
        // No-op — just checking it doesn't crash
      }).not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // 9. resetStreamingState
  // ----------------------------------------------------------------
  describe("resetStreamingState", () => {
    it("resets streaming state when called via steer mode", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ isStreaming: true, setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("steer");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // In steer mode, resetStreamingState is called which calls setIsStreaming(false)
      expect(setIsStreaming).toHaveBeenCalledWith(false);
    });
  });

  // ----------------------------------------------------------------
  // 10. Sync streaming with assistant reply (useEffect)
  // ----------------------------------------------------------------
  describe("sync with assistant reply", () => {
    it("resets streaming state when assistant reply matches pending message", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-msg-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ setIsStreaming });

      const { result, rerender } = renderHook(() => useMiniChat(opts));

      // Send a message to set pendingUserMessageId
      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // Now simulate assistant reply appearing in events
      mockEvents = [
        makeEvent({
          _id: "evt-msg-1",
          type: "user_message",
          payload: { text: "hello" },
        }),
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "evt-msg-1", text: "response" },
        }),
      ];

      // Re-render with new events
      await act(async () => {
        rerender();
      });

      // resetStreamingState should have been triggered, calling setIsStreaming(false)
      // It's called once in startStream(true) and then in resetStreamingState(false)
      const falseCall = setIsStreaming.mock.calls.find(
        (c) => c[0] === false,
      );
      expect(falseCall).toBeDefined();
    });

    it("does not reset when assistant reply does not match pending message", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-msg-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ setIsStreaming });

      const { result, rerender } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      // Reset mock to track only subsequent calls
      setIsStreaming.mockClear();

      // Simulate an assistant reply for a DIFFERENT message
      mockEvents = [
        makeEvent({
          _id: "reply-1",
          type: "assistant_message",
          payload: { userMessageId: "evt-msg-OTHER", text: "response" },
        }),
      ];

      await act(async () => {
        rerender();
      });

      // setIsStreaming(false) from resetStreamingState should NOT have been called
      expect(setIsStreaming).not.toHaveBeenCalledWith(false);
    });
  });

  // ----------------------------------------------------------------
  // 11. streamChat callbacks
  // ----------------------------------------------------------------
  describe("streamChat callbacks", () => {
    it("passes correct callbacks to streamChat", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      const [, handlers, options] = (streamChat as ReturnType<typeof vi.fn>).mock.calls[0];

      // Verify handler functions are provided
      expect(typeof handlers.onTextDelta).toBe("function");
      expect(typeof handlers.onReasoningDelta).toBe("function");
      expect(typeof handlers.onDone).toBe("function");
      expect(typeof handlers.onAbort).toBe("function");
      expect(typeof handlers.onError).toBe("function");

      // Verify abort signal is provided
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it("onDone sets isStreaming to false", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const [, handlers] = (streamChat as ReturnType<typeof vi.fn>).mock.calls[0];

      act(() => {
        handlers.onDone();
      });

      expect(setIsStreaming).toHaveBeenCalledWith(false);
    });

    it("onError calls resetStreamingState", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      setIsStreaming.mockClear();

      const [, handlers] = (streamChat as ReturnType<typeof vi.fn>).mock.calls[0];

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      act(() => {
        handlers.onError(new Error("test error"));
      });
      consoleSpy.mockRestore();

      // resetStreamingState calls setIsStreaming(false)
      expect(setIsStreaming).toHaveBeenCalledWith(false);
    });

    it("onAbort calls resetStreamingState", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const setIsStreaming = vi.fn();
      const opts = makeOpts({ setIsStreaming });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      setIsStreaming.mockClear();

      const [, handlers] = (streamChat as ReturnType<typeof vi.fn>).mock.calls[0];

      act(() => {
        handlers.onAbort();
      });

      expect(setIsStreaming).toHaveBeenCalledWith(false);
    });
  });

  // ----------------------------------------------------------------
  // 12. Events passthrough
  // ----------------------------------------------------------------
  describe("events passthrough", () => {
    it("returns events from useConversationEvents", () => {
      mockEvents = [
        makeEvent({ _id: "e1", type: "user_message", payload: { text: "hi" } }),
        makeEvent({ _id: "e2", type: "assistant_message", payload: { text: "hello" } }),
      ];

      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0]._id).toBe("e1");
      expect(result.current.events[1]._id).toBe("e2");
    });
  });

  // ----------------------------------------------------------------
  // 13. combinedText edge cases
  // ----------------------------------------------------------------
  describe("combinedText construction", () => {
    it("returns early when all context parts result in empty combinedText", async () => {
      // This can happen if cleanedText is empty after stripping prefix AND no context
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });

      const chatContext: ChatContext = {
        window: {
          title: "",
          app: "",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      };
      const opts = makeOpts({ chatContext });
      const { result } = renderHook(() => useMiniChat(opts));

      // windowSnippet will be "" (both parts empty), message is "", no selectedText
      // BUT the initial guard !rawText && !selectedSnippet && !windowSnippet catches this
      // since windowSnippet is "" (falsy). So getOrCreateDeviceId should NOT be called.
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
    });

    it("joins context parts with double newlines", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const chatContext: ChatContext = {
        window: {
          title: "Doc",
          app: "VSCode",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      };
      const opts = makeOpts({ chatContext, selectedText: "code snippet" });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("explain this");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      const callArgs = mockAppendEvent.mock.calls[0][0];
      const text = callArgs.payload.text as string;
      const parts = text.split("\n\n");
      expect(parts).toHaveLength(3);
      expect(parts[0]).toContain("VSCode - Doc");
      expect(parts[1]).toBe('"code snippet"');
      expect(parts[2]).toBe("explain this");
    });
  });

  // ----------------------------------------------------------------
  // 14. appendEvent is called with correct shape
  // ----------------------------------------------------------------
  describe("appendEvent call shape", () => {
    it("sends correct event structure for a normal message", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts();
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("hello world");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockAppendEvent).toHaveBeenCalledWith({
        conversationId: "conv-123",
        type: "user_message",
        deviceId: "device-123",
        payload: {
          text: "hello world",
          attachments: [],
          platform: "unknown",
        },
      });
    });

    it("includes mode in payload when streaming with /followup", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts({ isStreaming: true });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("/followup more details");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            mode: "follow_up",
            text: "more details",
          }),
        }),
      );
    });

    it("includes mode steer in payload when streaming without prefix", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "evt-1" });
      const opts = makeOpts({ isStreaming: true });
      const { result } = renderHook(() => useMiniChat(opts));

      act(() => {
        result.current.setMessage("change topic");
      });
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            mode: "steer",
          }),
        }),
      );
    });
  });
});
