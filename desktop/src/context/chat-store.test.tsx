import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAppendLocalEvent = vi.fn((args?: unknown) => {
  void args;
  return { _id: "local-123" };
});
const mockBuildLocalHistoryMessages = vi.fn((conversationId?: string, max?: number) => {
  void conversationId;
  void max;
  return [{ role: "user" as const, content: "hello" }];
});
const mockUploadScreenshotAttachments = vi.fn((args?: unknown) => {
  void args;
  return Promise.resolve([]);
});

const mockConvexAppendEvent = vi.fn(() => Promise.resolve({ _id: "cloud-456" }));
const mockWithOptimisticUpdate = vi.fn(() => mockConvexAppendEvent);
const mockConvexMutation = vi.fn((ref?: unknown) => {
  void ref;
  return Object.assign(vi.fn(), { withOptimisticUpdate: mockWithOptimisticUpdate });
});
const mockConvexAction = vi.fn((ref?: unknown) => {
  void ref;
  return vi.fn();
});
const mockInsertAtTop = vi.fn();

const mockUseConvexAuth = vi.fn(() => ({
  isAuthenticated: true,
  isLoading: false,
}));
const mockUseQuery = vi.fn(() => "connected");

vi.mock("convex/react", () => ({
  insertAtTop: (args: unknown) => mockInsertAtTop(args),
  useConvexAuth: () => mockUseConvexAuth(),
  useQuery: () => mockUseQuery(),
  useMutation: (ref: unknown) => mockConvexMutation(ref),
  useAction: (ref: unknown) => mockConvexAction(ref),
}));

vi.mock("@/convex/api", () => ({
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

vi.mock("@/app/chat/services/local-chat-store", () => ({
  appendLocalEvent: (args: unknown) => mockAppendLocalEvent(args),
  buildLocalHistoryMessages: (conversationId: string) =>
    mockBuildLocalHistoryMessages(conversationId),
}));

vi.mock("@/app/chat/streaming/attachment-upload", () => ({
  uploadScreenshotAttachments: (args: unknown) =>
    mockUploadScreenshotAttachments(args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ChatStoreProvider, useChatStore } from "./chat-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
  return <ChatStoreProvider>{children}</ChatStoreProvider>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatStoreProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    // Default: authenticated + connected + sync on → cloud
    mockUseQuery.mockReturnValue("connected");
  });

  // ----------------------------------------------------------------
  // storageMode derivation
  // ----------------------------------------------------------------
  describe("storageMode derivation", () => {
    it("returns cloud when authenticated and connected with sync on", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.storageMode).toBe("cloud");
      expect(result.current.isLocalStorage).toBe(false);
      expect(result.current.cloudFeaturesEnabled).toBe(true);
      expect(result.current.storageMode).toBe("cloud");
    });

    it("returns local when not authenticated", () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.storageMode).toBe("local");
      expect(result.current.isLocalStorage).toBe(true);
      expect(result.current.cloudFeaturesEnabled).toBe(false);
      expect(result.current.storageMode).toBe("local");
    });

    it("returns local when accountMode is private_local", () => {
      mockUseQuery.mockReturnValue("private_local");

      const { result } = renderHook(() => useChatStore(), { wrapper });

      expect(result.current.storageMode).toBe("local");
      expect(result.current.isLocalStorage).toBe(true);
    });

    it("returns local when syncMode is off", async () => {
      // Mock electronAPI.getLocalSyncMode to return "off"
      const original = globalThis.window?.electronAPI;
      Object.defineProperty(globalThis, "window", {
        value: {
          ...globalThis.window,
          electronAPI: {
            ...original,
            system: { getLocalSyncMode: () => Promise.resolve("off") },
          },
        },
        writable: true,
      });

      const { result, rerender } = renderHook(() => useChatStore(), { wrapper });

      // Wait for the async useEffect to resolve
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      rerender();

      expect(result.current.storageMode).toBe("local");

      // Restore
      Object.defineProperty(globalThis, "window", {
        value: { ...globalThis.window, electronAPI: original },
        writable: true,
      });
    });
  });

  // ----------------------------------------------------------------
  // appendEvent
  // ----------------------------------------------------------------
  describe("appendEvent", () => {
    it("registers an optimistic paginated insert for cloud user messages", () => {
      renderHook(() => useChatStore(), { wrapper });

      expect(mockWithOptimisticUpdate).toHaveBeenCalledTimes(1);
      const optimisticCalls = mockWithOptimisticUpdate.mock.calls as Array<
        [((localStore: unknown, args: Record<string, unknown>) => void)?]
      >;
      const optimisticUpdate = optimisticCalls[0]?.[0];
      expect(optimisticUpdate).toBeTypeOf("function");

      const localStore = {};
      act(() => {
        optimisticUpdate?.(localStore, {
          conversationId: "cloud-conv-1",
          type: "user_message",
          deviceId: "device-1",
          payload: { text: "hello cloud" },
        });
      });

      expect(mockInsertAtTop).toHaveBeenCalledWith(
        expect.objectContaining({
          paginatedQuery: "listEvents",
          argsToMatch: { conversationId: "cloud-conv-1" },
          localQueryStore: localStore,
          item: expect.objectContaining({
            type: "user_message",
            deviceId: "device-1",
            payload: { text: "hello cloud" },
          }),
        }),
      );
    });

    it("returns cloud event id when cloud append succeeds", async () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });
      mockUseQuery.mockReturnValue("connected");
      mockConvexAppendEvent.mockResolvedValueOnce({ _id: "cloud-456" });

      const { result } = renderHook(() => useChatStore(), { wrapper });

      let response: unknown;
      await act(async () => {
        response = await result.current.appendEvent({
          conversationId: "cloud-conv-1",
          type: "user_message",
          deviceId: "device-1",
          payload: { text: "hello cloud" },
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalled();
      expect(mockConvexAppendEvent).toHaveBeenCalled();
      expect(response).toEqual({ _id: "cloud-456" });
    });

    it("falls back to local event id when cloud append fails", async () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
      });
      mockUseQuery.mockReturnValue("connected");
      mockConvexAppendEvent.mockRejectedValueOnce(new Error("cloud down"));

      const { result } = renderHook(() => useChatStore(), { wrapper });

      let response: unknown;
      await act(async () => {
        response = await result.current.appendEvent({
          conversationId: "cloud-conv-1",
          type: "user_message",
          deviceId: "device-1",
          payload: { text: "hello fallback" },
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalled();
      expect(mockConvexAppendEvent).toHaveBeenCalled();
      expect(response).toEqual({ _id: "local-123" });
    });

    it("calls appendLocalEvent in local mode", async () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

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

  // ----------------------------------------------------------------
  // appendAgentEvent
  // ----------------------------------------------------------------
  describe("appendAgentEvent", () => {
    it("writes to localStorage even in cloud mode for local history", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      act(() => {
        result.current.appendAgentEvent({
          conversationId: "conv-1",
          type: "assistant_message",
          finalText: "hello",
        });
      });

      expect(mockAppendLocalEvent).toHaveBeenCalled();
    });

    it("calls appendLocalEvent for assistant_message in local mode", () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

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

    it("calls appendLocalEvent for tool_request in local mode", () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

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

    it("calls appendLocalEvent for tool_result in local mode", () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

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

  // ----------------------------------------------------------------
  // uploadAttachments
  // ----------------------------------------------------------------
  describe("uploadAttachments", () => {
    it("returns empty array in local mode", async () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

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
      expect(mockUploadScreenshotAttachments).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // buildHistory
  // ----------------------------------------------------------------
  describe("buildHistory", () => {
    it("returns local history in cloud mode (both modes use local events)", () => {
      const { result } = renderHook(() => useChatStore(), { wrapper });

      const history = result.current.buildHistory("conv-1");
      expect(mockBuildLocalHistoryMessages).toHaveBeenCalled();
      expect(history).toEqual([{ role: "user", content: "hello" }]);
    });

    it("returns local history in local mode", () => {
      mockUseConvexAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
      });

      const { result } = renderHook(() => useChatStore(), { wrapper });

      const history = result.current.buildHistory("conv-1");

      expect(mockBuildLocalHistoryMessages).toHaveBeenCalled();
      expect(mockBuildLocalHistoryMessages.mock.calls[0]![0]).toBe("conv-1");
      expect(history).toEqual([{ role: "user", content: "hello" }]);
    });
  });

  // ----------------------------------------------------------------
  // Error when used outside provider
  // ----------------------------------------------------------------
  describe("useChatStore outside provider", () => {
    it("throws an error", () => {
      expect(() => {
        renderHook(() => useChatStore());
      }).toThrow("useChatStore must be used within ChatStoreProvider");
    });
  });
});

