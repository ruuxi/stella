import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentStreamEvent } from "../../../../../src/app/chat/streaming/streaming-types";

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

const mockAppendEvent = vi.fn<
  () => Promise<{ _id?: string; id?: string } | null>
>(() => Promise.resolve(null));
const mockAppendAgentEvent = vi.fn<
  (args: {
    conversationId: string;
    type: string;
    userMessageId?: string;
    toolCallId?: string;
    toolName?: string;
    resultPreview?: string;
    finalText?: string;
    taskId?: string;
    description?: string;
    agentType?: string;
    parentTaskId?: string;
  }) => Promise<void>
>(() => Promise.resolve());
const mockUploadAttachments = vi.fn(() => Promise.resolve([]));
const mockBuildHistory = vi.fn(() => undefined);
const mockAgentHealthCheck = vi.fn(() => Promise.resolve({ ready: true }));
const mockAgentStartChat = vi.fn(() => Promise.resolve({ runId: "run-1" }));
type AgentOnStreamHandler = (callback: (event: AgentStreamEvent) => void) => () => void;
const mockAgentOnStream = vi.fn<AgentOnStreamHandler>(() => vi.fn());

vi.mock("@/context/chat-store", () => ({
  useChatStore: vi.fn(() => ({
    storageMode: "local",
    isLocalStorage: true,
    cloudFeaturesEnabled: false,
    isAuthenticated: true,
    appendEvent: mockAppendEvent,
    appendAgentEvent: mockAppendAgentEvent,
    uploadAttachments: mockUploadAttachments,
    buildHistory: mockBuildHistory,
  })),
}));

vi.mock("../../../../../src/app/chat/hooks/use-raf-state", async () => {
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

import { useStreamingChat } from "../../../../../src/app/chat/hooks/use-streaming-chat";
import { getOrCreateDeviceId } from "@/platform/electron/device";
import type { EventRecord } from "../../../../../src/app/chat/lib/event-transforms";

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
    localStorage.clear();
    window.electronAPI = {
      agent: {
        healthCheck: mockAgentHealthCheck,
        startChat: mockAgentStartChat,
        onStream: mockAgentOnStream,
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.electronAPI;
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
      expect(mockAgentStartChat).not.toHaveBeenCalled();
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
      expect(mockAgentStartChat).not.toHaveBeenCalled();
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
      expect(mockAgentStartChat).not.toHaveBeenCalled();
    });

    it("does not replay queued follow_up events that already existed on mount", async () => {
      const events: EventRecord[] = [
        makeEvent({
          _id: "msg-1",
          timestamp: Date.now() - 5_000,
          type: "user_message",
          payload: { text: "open netflix and make it blue", mode: "follow_up" },
        }),
      ];

      renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockAgentStartChat).not.toHaveBeenCalled();
    });

    it("does not replay follow_up events created after mount from renderer state", async () => {
      const { rerender } = renderHook(
        ({ events }: { events: EventRecord[] }) =>
          useStreamingChat({ conversationId: "conv-1", events }),
        {
          initialProps: { events: [] as EventRecord[] },
        },
      );

      const nextEvents: EventRecord[] = [
        makeEvent({
          _id: "msg-2",
          timestamp: Date.now() + 1,
          type: "user_message",
          payload: { text: "open the browser again", mode: "follow_up" },
        }),
      ];

      rerender({ events: nextEvents });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockAgentStartChat).not.toHaveBeenCalled();
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

    it("clears the composer when a follow-up is queued during streaming", async () => {
      mockAppendEvent
        .mockResolvedValueOnce({ _id: "user-event-1" })
        .mockResolvedValueOnce({ _id: "follow-up-event-1" });

      const events: EventRecord[] = [
        makeEvent({
          _id: "pending-user-1",
          type: "user_message",
          payload: { text: "first request" },
        }),
      ];

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events }),
      );

      await act(async () => {
        await result.current.sendMessage({
          text: "first request",
          selectedText: null,
          chatContext: null,
          onClear: vi.fn(),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      const onClear = vi.fn();
      await act(async () => {
        await result.current.sendMessage({
          text: "follow-up request",
          selectedText: null,
          chatContext: null,
          onClear,
        });
      });

      expect(onClear).toHaveBeenCalledTimes(1);
      expect(mockAppendEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "user_message",
          payload: expect.objectContaining({
            text: "follow-up request",
            mode: "follow_up",
          }),
        }),
      );
      expect(mockAgentStartChat).toHaveBeenCalledTimes(2);
      expect(mockAgentStartChat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          userMessageId: "follow-up-event-1",
          userPrompt: "follow-up request",
        }),
      );
    });

    it("persists WebSearch tool results from streamed tool-end events", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "user-event-1" });

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      let unsubscribeCalled = false;
      mockAgentOnStream.mockImplementation((_callback: (event: AgentStreamEvent) => void) => {
        return () => {
          unsubscribeCalled = true;
        };
      });

      await act(async () => {
        await result.current.sendMessage({
          text: "search for news",
          selectedText: null,
          chatContext: null,
          onClear: vi.fn(),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      const callback = mockAgentOnStream.mock.calls[0]?.[0] as
        | ((event: AgentStreamEvent) => void)
        | undefined;

      expect(callback).toBeTypeOf("function");

      act(() => {
        callback?.({
          type: "tool-end",
          runId: "run-1",
          agentType: "orchestrator",
          seq: 1,
          toolCallId: "tool-1",
          toolName: "WebSearch",
          resultPreview: "HTML search briefing ready.",
        });
      });

      expect(mockAppendAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "tool_result",
          toolCallId: "tool-1",
          toolName: "WebSearch",
          resultPreview: "HTML search briefing ready.",
          agentType: "orchestrator",
        }),
      );
      expect(unsubscribeCalled).toBe(false);
    });

    it("persists streamed task lifecycle events so activity views can render them", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "user-event-1" });

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      );

      await act(async () => {
        await result.current.sendMessage({
          text: "restyle the dashboard",
          selectedText: null,
          chatContext: null,
          onClear: vi.fn(),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      const callback = mockAgentOnStream.mock.calls[0]?.[0] as
        | ((event: AgentStreamEvent) => void)
        | undefined;

      expect(callback).toBeTypeOf("function");

      act(() => {
        callback?.({
          type: "task-started",
          runId: "run-1",
          agentType: "general",
          seq: 1,
          taskId: "local:task:123",
          description: "Restyle Stella dashboard to look like Xbox dashboard",
          parentTaskId: "parent-task",
        });
      });

      expect(mockAppendAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "task-started",
          taskId: "local:task:123",
          description: "Restyle Stella dashboard to look like Xbox dashboard",
          agentType: "general",
          parentTaskId: "parent-task",
        }),
      );
    });

    it("keeps streamed text visible until the final assistant event is present in events", async () => {
      mockAppendEvent.mockResolvedValueOnce({ _id: "user-event-1" });

      const { result, rerender } = renderHook(
        ({ events }: { events: EventRecord[] }) =>
          useStreamingChat({ conversationId: "conv-1", events }),
        {
          initialProps: { events: [] as EventRecord[] },
        },
      );

      await act(async () => {
        await result.current.sendMessage({
          text: "hello",
          selectedText: null,
          chatContext: null,
          onClear: vi.fn(),
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      const callback = mockAgentOnStream.mock.calls[0]?.[0] as
        | ((event: AgentStreamEvent) => void)
        | undefined;

      expect(callback).toBeTypeOf("function");

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.pendingUserMessageId).toBe("user-event-1");

      await act(async () => {
        callback?.({
          type: "end",
          runId: "run-1",
          agentType: "orchestrator",
          seq: 2,
          finalText: "Hello there",
        });
        await Promise.resolve();
      });

      expect(mockAppendAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "assistant_message",
          userMessageId: "user-event-1",
          finalText: "Hello there",
        }),
      );
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.pendingUserMessageId).toBe("user-event-1");

      rerender({
        events: [
          makeEvent({
            _id: "assistant-event-1",
            type: "assistant_message",
            payload: { text: "Hello there", userMessageId: "user-event-1" },
          }),
        ],
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.streamingText).toBe("");
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.pendingUserMessageId).toBe("user-event-1");

      act(() => {
        const queued = [...rafCallbacks];
        rafCallbacks = [];
        queued.forEach((cb) => cb(performance.now()));
      });

      expect(result.current.pendingUserMessageId).toBeNull();
    });

    it("clears streaming state when a resumed background run ends without a linked user message", async () => {
      let streamCallback: ((event: AgentStreamEvent) => void) | undefined
      const unsubscribe = vi.fn()

      mockAgentOnStream.mockImplementation((callback) => {
        streamCallback = callback
        return unsubscribe
      })

      const mockGetActiveRun = vi
        .fn()
        .mockResolvedValueOnce({ runId: "bg-run-1", conversationId: "conv-1" })
        .mockResolvedValue(null)

      window.electronAPI = {
        agent: {
          healthCheck: mockAgentHealthCheck,
          startChat: mockAgentStartChat,
          onStream: mockAgentOnStream,
          getActiveRun: mockGetActiveRun,
          resumeStream: vi.fn(() =>
            Promise.resolve({ events: [] as AgentStreamEvent[], exhausted: false }),
          ),
        },
      } as unknown as typeof window.electronAPI

      const { result } = renderHook(() =>
        useStreamingChat({ conversationId: "conv-1", events: [] }),
      )

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(result.current.isStreaming).toBe(true)
      expect(result.current.pendingUserMessageId).toBeNull()

      await act(async () => {
        streamCallback?.({
          type: "end",
          runId: "bg-run-1",
          agentType: "orchestrator",
          seq: 1,
          finalText: "Background task finished",
        })
        await Promise.resolve()
      })

      expect(mockAppendAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "assistant_message",
          finalText: "Background task finished",
        }),
      )
      const assistantCall = mockAppendAgentEvent.mock.calls.find(
        ([arg]) => arg?.type === "assistant_message" && arg?.finalText === "Background task finished",
      )?.[0] as { userMessageId?: string } | undefined
      expect(assistantCall?.userMessageId).toBeUndefined()
      expect(result.current.isStreaming).toBe(false)
    });
  });
});




