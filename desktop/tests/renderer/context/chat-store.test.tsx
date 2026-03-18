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

const mockUseAuthSessionState = vi.fn(() => ({
  hasConnectedAccount: true,
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => mockUseAuthSessionState(),
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
    mockUseAuthSessionState.mockReturnValue({
      hasConnectedAccount: true,
    });
  });

  describe("storage mode", () => {
    it("always uses local transcript storage", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.storageMode).toBe("local");
      expect(result.current.isLocalStorage).toBe(true);
    });

    it("keeps cloud features disabled even when authenticated", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.cloudFeaturesEnabled).toBe(false);
      expect(result.current.isAuthenticated).toBe(true);
    });

    it("disables cloud features when not authenticated", () => {
      mockUseAuthSessionState.mockReturnValue({
        hasConnectedAccount: false,
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
          payload: { toolName: "bash", result: "output", resultPreview: "output" },
        }),
      );
    });

    it("stores tool result HTML alongside the persisted result payload", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "tool_result",
          toolCallId: "tc-2",
          toolName: "WebSearch",
          resultPreview: "HTML search briefing ready.",
          html: "<section><h3>Briefing</h3></section>",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tool_result",
          requestId: "tc-2",
          payload: {
            toolName: "WebSearch",
            result: "<section><h3>Briefing</h3></section>",
            resultPreview: "HTML search briefing ready.",
            html: "<section><h3>Briefing</h3></section>",
          },
        }),
      );
    });

    it("records task lifecycle events locally", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "task-started",
          taskId: "task-1",
          description: "Restyle dashboard",
          agentType: "general",
          parentTaskId: "parent-1",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "task_started",
          payload: {
            taskId: "task-1",
            description: "Restyle dashboard",
            agentType: "general",
            parentTaskId: "parent-1",
          },
        }),
      );
    });

    it("records canceled tasks locally", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "task-canceled",
          taskId: "task-1",
          error: "Canceled by user",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "task_canceled",
          payload: {
            taskId: "task-1",
            error: "Canceled by user",
          },
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


