import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

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

  it("builds message history from local events", async () => {
    const { result } = renderHook(() => useChatStore(), { wrapper });

    let history: unknown;
    await act(async () => {
      history = await result.current.buildHistory("conv-1");
    });

    expect(mockBuildLocalHistoryMessages).toHaveBeenCalledWith("conv-1");
    expect(history).toEqual([{ role: "user", content: "hello" }]);
  });

  it("throws when used outside provider", () => {
    expect(() => {
      renderHook(() => useChatStore());
    }).toThrow("useChatStore must be used within ChatStoreProvider");
  });
});
