import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/app/chat/hooks/use-resume-agent-run", () => ({
  useResumeAgentRun: vi.fn(),
}));

vi.mock("../../../../../src/ui/toast", () => ({
  showToast: vi.fn(),
}));

import { useLocalAgentStream } from "../../../../../src/app/chat/streaming/use-local-agent-stream";

describe("useLocalAgentStream", () => {
  let rafCallbacks: FrameRequestCallback[];
  let resolveStartChat:
    | ((value: { runId: string; userMessageId: string }) => void)
    | null;
  let streamCallback:
    | ((event: {
        type: "end";
        runId: string;
        agentType: "orchestrator";
        seq: number;
        finalText: string;
      }) => void)
    | null;

  const mockHealthCheck = vi.fn(() => Promise.resolve({ ready: true }));
  const mockStartChat = vi.fn(
    () =>
      new Promise<{ runId: string; userMessageId: string }>((resolve) => {
        resolveStartChat = resolve;
      }),
  );
  const mockCancelChat = vi.fn();
  const mockOnStream = vi.fn((callback) => {
    streamCallback = callback;
    return vi.fn();
  });

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const flushRaf = async () => {
    const callbacks = [...rafCallbacks];
    rafCallbacks = [];
    for (const callback of callbacks) {
      callback(0);
    }
    await flushMicrotasks();
  };

  beforeEach(() => {
    rafCallbacks = [];
    resolveStartChat = null;
    streamCallback = null;
    vi.clearAllMocks();

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => 0);

    window.electronAPI = {
      agent: {
        healthCheck: mockHealthCheck,
        startChat: mockStartChat,
        cancelChat: mockCancelChat,
        onStream: mockOnStream,
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.electronAPI;
  });

  it("cancels a run that is stopped before startChat resolves", async () => {
    const { result } = renderHook(() =>
      useLocalAgentStream({
        activeConversationId: "conv-1",
        storageMode: "local",
      }),
    );

    await act(async () => {
      result.current.startStream({
        userPrompt: "hello",
      });
      await flushMicrotasks();
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.pendingUserMessageId).toBeNull();
    expect(mockStartChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.cancelCurrentStream();
      await flushRaf();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.pendingUserMessageId).toBeNull();
    expect(mockCancelChat).not.toHaveBeenCalled();

    await act(async () => {
      resolveStartChat?.({ runId: "run-1", userMessageId: "msg-1" });
      await flushMicrotasks();
    });

    expect(mockCancelChat).toHaveBeenCalledTimes(1);
    expect(mockCancelChat).toHaveBeenCalledWith("run-1");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.pendingUserMessageId).toBeNull();
  });

  it("tracks the persisted user message id returned by startChat", async () => {
    const { result } = renderHook(() =>
      useLocalAgentStream({
        activeConversationId: "conv-1",
        storageMode: "local",
      }),
    );

    await act(async () => {
      result.current.startStream({
        userPrompt: "open youtube",
      });
      await flushMicrotasks();
    });

    expect(result.current.pendingUserMessageId).toBeNull();

    await act(async () => {
      resolveStartChat?.({ runId: "run-1", userMessageId: "msg-1" });
      await flushMicrotasks();
    });

    expect(result.current.pendingUserMessageId).toBe("msg-1");
  });

  it("passes attachments through when starting a local chat run", async () => {
    const { result } = renderHook(() =>
      useLocalAgentStream({
        activeConversationId: "conv-1",
        storageMode: "local",
      }),
    );

    await act(async () => {
      result.current.startStream({
        userPrompt: "describe this screenshot",
        attachments: [
          {
            url: "data:image/png;base64,abc",
            mimeType: "image/png",
          },
        ],
      });
      await flushMicrotasks();
    });

    expect(mockStartChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        userPrompt: "describe this screenshot",
        attachments: [
          {
            url: "data:image/png;base64,abc",
            mimeType: "image/png",
          },
        ],
        storageMode: "local",
      }),
    );
    expect(streamCallback).toBeTypeOf("function");
  });
});
