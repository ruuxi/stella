import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

let mockConversationId: string | null = "conv-123";

vi.mock("@/context/ui-state", () => ({
  useUiState: vi.fn(() => ({
    state: {
      get conversationId() {
        return mockConversationId;
      },
    },
  })),
}));

import { useMiniChat } from "../../../../../src/app/shell/mini/use-mini-chat";
import type {
  ChatContext,
  MiniBridgeRequest,
  MiniBridgeUpdate,
} from "@/types/electron";

function makeSnapshot(overrides?: Partial<MiniBridgeUpdate["snapshot"]>) {
  return {
    conversationId: mockConversationId,
    events: [],
    streamingText: "",
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null,
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<Parameters<typeof useMiniChat>[0]>) {
  return {
    chatContext: null as ChatContext | null,
    selectedText: null as string | null,
    setChatContext: vi.fn(),
    setSelectedText: vi.fn(),
    ...overrides,
  };
}

describe("useMiniChat", () => {
  const mockMiniBridgeRequest = vi.fn();
  let onUpdateHandler: ((update: MiniBridgeUpdate) => void) | null = null;

  beforeEach(() => {
    mockConversationId = "conv-123";
    onUpdateHandler = null;
    mockMiniBridgeRequest.mockReset();

    const snapshot = makeSnapshot();
    mockMiniBridgeRequest.mockImplementation(async (request: MiniBridgeRequest) => {
      if (request.type === "query:snapshot") {
        return { type: "query:snapshot", snapshot } as const;
      }
      return { type: "mutation:sendMessage", accepted: true } as const;
    });

    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      writable: true,
      value: {
        mini: {
          request: mockMiniBridgeRequest,
          onUpdate: (callback: (update: MiniBridgeUpdate) => void) => {
            onUpdateHandler = callback;
            return () => {
              onUpdateHandler = null;
            };
          },
        },
      },
    });
  });

  it("loads initial snapshot through IPC query", async () => {
    const { result } = renderHook(() => useMiniChat(makeOpts()));

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.events).toEqual([]);
    });

    expect(mockMiniBridgeRequest).toHaveBeenCalledWith({
      type: "query:snapshot",
      conversationId: "conv-123",
    });
  });

  it("sends message through IPC mutation and clears local composer context", async () => {
    const setChatContext = vi.fn();
    const setSelectedText = vi.fn();

    const opts = makeOpts({
      setChatContext,
      setSelectedText,
      selectedText: "selected",
    });

    const { result } = renderHook(() => useMiniChat(opts));

    await waitFor(() => {
      expect(mockMiniBridgeRequest).toHaveBeenCalled();
    });

    act(() => {
      result.current.setMessage("hello world");
    });

    await act(async () => {
      await result.current.sendMessage();
    });

    expect(mockMiniBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mutation:sendMessage",
        conversationId: "conv-123",
        text: "hello world",
        selectedText: "selected",
      }),
    );
    expect(setSelectedText).toHaveBeenCalledWith(null);
    expect(setChatContext).toHaveBeenCalledWith(null);
    expect(result.current.message).toBe("");
  });

  it("applies live snapshot updates from full window bridge", async () => {
    const { result } = renderHook(() => useMiniChat(makeOpts()));

    await waitFor(() => {
      expect(onUpdateHandler).toBeTypeOf("function");
      expect(mockMiniBridgeRequest).toHaveBeenCalled();
    });

    act(() => {
      onUpdateHandler?.({
        type: "snapshot",
        snapshot: makeSnapshot({
          events: [
            {
              _id: "e1",
              type: "assistant_message",
              timestamp: 1,
              payload: { text: "hello" },
            },
          ],
          streamingText: "typing",
          isStreaming: true,
          pendingUserMessageId: "u1",
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
      expect(result.current.streamingText).toBe("typing");
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.pendingUserMessageId).toBe("u1");
    });
  });
});


