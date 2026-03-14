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
  let resolveStartChat: ((value: { runId: string }) => void) | null;

  const mockHealthCheck = vi.fn(() => Promise.resolve({ ready: true }));
  const mockStartChat = vi.fn(() => new Promise<{ runId: string }>((resolve) => {
    resolveStartChat = resolve;
  }));
  const mockCancelChat = vi.fn();
  const mockOnStream = vi.fn(() => vi.fn());

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
    const appendAgentEvent = vi.fn();
    const { result } = renderHook(() =>
      useLocalAgentStream({
        activeConversationId: "conv-1",
        storageMode: "local",
        appendAgentEvent,
      }),
    );

    await act(async () => {
      result.current.startStream({
        userMessageId: "msg-1",
        userPrompt: "hello",
      });
      await flushMicrotasks();
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.pendingUserMessageId).toBe("msg-1");
    expect(mockStartChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.cancelCurrentStream();
      await flushRaf();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.pendingUserMessageId).toBeNull();
    expect(mockCancelChat).not.toHaveBeenCalled();

    await act(async () => {
      resolveStartChat?.({ runId: "run-1" });
      await flushMicrotasks();
    });

    expect(mockCancelChat).toHaveBeenCalledTimes(1);
    expect(mockCancelChat).toHaveBeenCalledWith("run-1");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.pendingUserMessageId).toBeNull();
  });
});
