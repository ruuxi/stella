import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { UiStateProvider, useUiState } from "./ui-state";

const wrapper = ({ children }: { children: ReactNode }) => (
  <UiStateProvider>{children}</UiStateProvider>
);

describe("UiStateProvider + useUiState", () => {
  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("starts with default state", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });
    expect(result.current.state).toEqual({
      mode: "chat",
      window: "full",
      view: "chat",
      conversationId: null,
      isVoiceActive: false,
    });
  });

  it("setMode updates mode", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setMode("voice");
    });

    expect(result.current.state.mode).toBe("voice");
  });

  it("setView updates view", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setView("store");
    });

    expect(result.current.state.view).toBe("store");
  });

  it("setConversationId updates conversationId", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setConversationId("conv-123");
    });

    expect(result.current.state.conversationId).toBe("conv-123");
  });

  it("setConversationId can set to null", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setConversationId("conv-123");
    });
    act(() => {
      result.current.setConversationId(null);
    });

    expect(result.current.state.conversationId).toBeNull();
  });

  it("setWindow to full forces chat mode", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    // First set to voice mode
    act(() => {
      result.current.setMode("voice");
    });
    expect(result.current.state.mode).toBe("voice");

    // Switching to full should force chat mode
    act(() => {
      result.current.setWindow("full");
    });

    expect(result.current.state.window).toBe("full");
    expect(result.current.state.mode).toBe("chat");
  });

  it("setWindow to mini does not force mode change", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setMode("voice");
    });
    act(() => {
      result.current.setWindow("mini");
    });

    expect(result.current.state.window).toBe("mini");
    expect(result.current.state.mode).toBe("voice");
  });

  it("setWindow calls showWindow on electron API", () => {
    const mockShowWindow = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      getUiState: vi.fn().mockResolvedValue({
        mode: "chat",
        window: "full",
        view: "chat",
        conversationId: null,
      }),
      onUiState: vi.fn().mockReturnValue(() => {}),
      setUiState: vi.fn(),
      showWindow: mockShowWindow,
    };

    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setWindow("mini");
    });

    expect(mockShowWindow).toHaveBeenCalledWith("mini");
  });

  it("updateState merges partial state", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.updateState({ mode: "voice", view: "store" });
    });

    expect(result.current.state.mode).toBe("voice");
    expect(result.current.state.view).toBe("store");
    // Other fields unchanged
    expect(result.current.state.window).toBe("full");
    expect(result.current.state.conversationId).toBeNull();
  });
});

describe("useUiState outside provider", () => {
  it("throws when used outside UiStateProvider", () => {
    expect(() => {
      renderHook(() => useUiState());
    }).toThrow("useUiState must be used within UiStateProvider");
  });
});
