import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { UiStateProvider, useUiState } from "../../../src/context/ui-state";

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
      view: "home",
      conversationId: null,
      isVoiceActive: false,
      isVoiceRtcActive: false,
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
      result.current.setView("app");
    });

    expect(result.current.state.view).toBe("app");
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

  it("setWindow calls showWindow on electron API", async () => {
    const mockShowWindow = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      ui: {
        getState: vi.fn().mockResolvedValue({
          mode: "chat",
          window: "full",
          view: "chat",
          conversationId: null,
        }),
        onState: vi.fn().mockReturnValue(() => {}),
        setState: vi.fn(),
      },
      window: {
        show: mockShowWindow,
      },
    };

    const { result } = renderHook(() => useUiState(), { wrapper });

    await waitFor(() => {
      expect(result.current.state.view).toBe("chat");
    });

    act(() => {
      result.current.setWindow("mini");
    });

    expect(mockShowWindow).toHaveBeenCalledWith("mini");
  });

  it("updateState merges partial state", () => {
    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.updateState({ mode: "voice", view: "app" });
    });

    expect(result.current.state.mode).toBe("voice");
    expect(result.current.state.view).toBe("app");
    // Other fields unchanged
    expect(result.current.state.window).toBe("full");
    expect(result.current.state.conversationId).toBeNull();
  });

  it("preserves local updates that happen before initial main-process hydration resolves", async () => {
    let resolveGetState: ((value: {
      mode: "chat" | "voice";
      window: "full" | "mini";
      view: "home" | "chat" | "app";
      conversationId: string | null;
      isVoiceActive: boolean;
      isVoiceRtcActive: boolean;
    }) => void) | null = null;

    ((window as unknown as Record<string, unknown>)).electronAPI = {
      ui: {
        getState: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveGetState = resolve;
            }),
        ),
        onState: vi.fn().mockReturnValue(() => {}),
        setState: vi.fn(),
      },
      window: {
        show: vi.fn(),
      },
    };

    const { result } = renderHook(() => useUiState(), { wrapper });

    act(() => {
      result.current.setConversationId("conv-123");
    });

    expect(result.current.state.conversationId).toBe("conv-123");

    act(() => {
      resolveGetState?.({
        mode: "chat",
        window: "full",
        view: "chat",
        conversationId: null,
        isVoiceActive: false,
        isVoiceRtcActive: false,
      });
    });

    await waitFor(() => {
      expect(result.current.state.view).toBe("chat");
      expect(result.current.state.conversationId).toBe("conv-123");
    });
  });

  it("re-renders when the main process reuses and mutates the same state object", async () => {
    let onState:
      | ((state: {
          mode: "chat" | "voice";
          window: "full" | "mini";
          view: "home" | "chat" | "app";
          conversationId: string | null;
          isVoiceActive: boolean;
          isVoiceRtcActive: boolean;
        }) => void)
      | null = null;

    const sharedState = {
      mode: "chat" as const,
      window: "full" as const,
      view: "home" as const,
      conversationId: null as string | null,
      isVoiceActive: false,
      isVoiceRtcActive: false,
    };

    ((window as unknown as Record<string, unknown>)).electronAPI = {
      ui: {
        getState: vi.fn().mockResolvedValue(sharedState),
        onState: vi.fn().mockImplementation((callback) => {
          onState = callback;
          return () => {};
        }),
        setState: vi.fn(),
      },
      window: {
        show: vi.fn(),
      },
    };

    const { result } = renderHook(() => {
      const { state } = useUiState();
      return {
        view: state.view,
        conversationId: state.conversationId,
      };
    }, { wrapper });

    await waitFor(() => {
      expect(result.current.view).toBe("home");
      expect(result.current.conversationId).toBeNull();
    });

    act(() => {
      onState?.(sharedState);
    });

    act(() => {
      sharedState.view = "chat";
      sharedState.conversationId = "conv-123";
      onState?.(sharedState);
    });

    await waitFor(() => {
      expect(result.current.view).toBe("chat");
      expect(result.current.conversationId).toBe("conv-123");
    });
  });
});

describe("useUiState outside provider", () => {
  it("throws when used outside UiStateProvider", () => {
    expect(() => {
      renderHook(() => useUiState());
    }).toThrow("useUiState must be used within UiStateProvider");
  });
});
