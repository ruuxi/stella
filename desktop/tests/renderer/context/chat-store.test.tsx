import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

const mockAppendLocalEvent = vi.fn((args?: unknown) => {
  void args;
  return Promise.resolve({ _id: "local-123" });
});
const mockBuildLocalHistoryMessages = vi.fn((conversationId?: string) => {
  void conversationId;
  return Promise.resolve([{ role: "user" as const, content: "hello" }]);
});

const mockUseConvexAuth = vi.fn(() => ({
  isAuthenticated: true,
  isLoading: false,
}));
const mockUseQuery = vi.fn(() => "connected");

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
  useQuery: () => mockUseQuery(),
}));

vi.mock("@/convex/api", () => ({
  api: {
    data: {
      preferences: {
        getAccountMode: "getAccountMode",
      },
    },
  },
}));

vi.mock("@/app/chat/services/local-chat-store", () => ({
  appendLocalEvent: (args: unknown) => mockAppendLocalEvent(args),
  buildLocalHistoryMessages: (conversationId: string) =>
    mockBuildLocalHistoryMessages(conversationId),
}));

import { ChatStoreProvider, useChatStore } from "../../../src/context/chat-store";

function wrapper({ children }: { children: ReactNode }) {
  return <ChatStoreProvider>{children}</ChatStoreProvider>;
}

describe("ChatStoreProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseQuery.mockReturnValue("connected");
  });

  describe("storage mode", () => {
    it("always uses local transcript storage", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.storageMode).toBe("local");
      expect(result.current.isLocalStorage).toBe(true);
    });

    it("still exposes cloud feature availability for connected accounts", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.cloudFeaturesEnabled).toBe(true);
      expect(result.current.isAuthenticated).toBe(true);
    });

    it("disables cloud features when not authenticated", () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.storageMode).toBe("local");
      expect(result.current.cloudFeaturesEnabled).toBe(false);
      expect(result.current.isAuthenticated).toBe(false);
    });
  });

  describe("appendEvent", () => {
    it("writes user messages to the local transcript store", async () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      let response: unknown;
      await act(async () => {
        response = await result.current.appendEvent({
          conversationId: "conv-1",
          type: "user_message",
          deviceId: "device-1",
          payload: { text: "hello" },
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "user_message",
          deviceId: "device-1",
        }),
      );
      expect(response).toEqual({ _id: "local-123" });
    });
  });

  describe("appendAgentEvent", () => {
    it("records assistant messages locally", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "assistant_message",
          userMessageId: "msg-1",
          finalText: "response text",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "assistant_message",
          requestId: "msg-1",
          payload: expect.objectContaining({
            text: "response text",
            userMessageId: "msg-1",
          }),
        }),
      );
    });

    it("records tool requests locally", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "tool_request",
          toolCallId: "tc-1",
          toolName: "bash",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tool_request",
          requestId: "tc-1",
          payload: { toolName: "bash" },
        }),
      );
    });

    it("records tool results locally", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "tool_result",
          toolCallId: "tc-1",
          toolName: "bash",
          resultPreview: "output",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tool_result",
          requestId: "tc-1",
          payload: { toolName: "bash", result: "output" },
        }),
      );
    });
  });

  describe("uploadAttachments", () => {
    it("does not upload transcript attachments to Convex", async () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      let attachments: unknown;
      await act(async () => {
        attachments = await result.current.uploadAttachments({
          screenshots: [{ dataUrl: "data:image/png;base64,abc" }],
          conversationId: "conv-1",
          deviceId: "device-1",
        });
      });

      expect(attachments).toEqual([]);
    });
  });

  describe("buildHistory", () => {
    it("builds message history from local events", async () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      let history: unknown;
      await act(async () => {
        history = await result.current.buildHistory("conv-1");
      });

      expect(mockBuildLocalHistoryMessages).toHaveBeenCalledWith("conv-1");
      expect(history).toEqual([{ role: "user", content: "hello" }]);
    });
  });

  describe("useChatStore outside provider", () => {
    it("throws an error", () => {
      expect(() => {
        renderHook(() => useChatStore());
      }).toThrow("useChatStore must be used within ChatStoreProvider");
    });
  });
});
