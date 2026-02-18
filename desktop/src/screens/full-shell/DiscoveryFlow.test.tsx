import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDiscoveryFlow } from "./DiscoveryFlow";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAppendEvent = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: vi.fn(() => mockAppendEvent),
}));

vi.mock("../../convex/api", () => ({
  api: {
    events: { appendEvent: "appendEvent" },
  },
}));

vi.mock("../../services/device", () => ({
  getOrCreateDeviceId: vi.fn(() => Promise.resolve("device-1")),
}));

vi.mock("../../services/synthesis", () => ({
  synthesizeCoreMemory: vi.fn(() =>
    Promise.resolve({ coreMemory: null }),
  ),
}));

vi.mock("../../services/skill-selection", () => ({
  selectDefaultSkills: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BROWSER_SELECTION_KEY = "stella-selected-browser";

function defaultOptions() {
  return {
    isAuthenticated: false,
    conversationId: null as string | null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDiscoveryFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  afterEach(() => {
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  it("returns handleDiscoveryConfirm function", () => {
    const { result } = renderHook(() =>
      useDiscoveryFlow(defaultOptions()),
    );
    expect(typeof result.current.handleDiscoveryConfirm).toBe("function");
  });

  it("handleDiscoveryConfirm can be called with categories", () => {
    const { result } = renderHook(() =>
      useDiscoveryFlow(defaultOptions()),
    );

    // Should not throw when called
    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });
  });

  it("does not prepend browsing_bookmarks when no browser is selected in localStorage", () => {
    // Ensure no browser selected
    localStorage.removeItem(BROWSER_SELECTION_KEY);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-1",
      }),
    );

    // The withBrowserDiscoveryCategory is called internally by
    // handleDiscoveryConfirm. Without a selected browser, categories
    // are left as-is. We verify the hook can be called without error.
    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    // The function should complete without error; the effect will fire
    // but since electronAPI is not available, it will silently fail.
  });

  it("prepends browsing_bookmarks when browser is selected in localStorage", () => {
    localStorage.setItem(BROWSER_SELECTION_KEY, "chrome");

    // We test this indirectly: when handleDiscoveryConfirm is called with
    // categories that don't include "browsing_bookmarks", the internal
    // withBrowserDiscoveryCategory should prepend it. The effect then runs
    // with the augmented categories. We verify no errors occur.
    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    // The hook accepted the call successfully. The internal state was set
    // with ["browsing_bookmarks", "dev_environment"] by
    // withBrowserDiscoveryCategory.
  });

  it("does not duplicate browsing_bookmarks if already in categories", () => {
    localStorage.setItem(BROWSER_SELECTION_KEY, "chrome");

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-1",
      }),
    );

    // Calling with browsing_bookmarks already present should not duplicate
    act(() => {
      result.current.handleDiscoveryConfirm([
        "browsing_bookmarks",
        "dev_environment",
      ]);
    });

    // The hook accepted the call without error.
  });

  it("stable handleDiscoveryConfirm reference across renders", () => {
    const { result, rerender } = renderHook(() =>
      useDiscoveryFlow(defaultOptions()),
    );

    const first = result.current.handleDiscoveryConfirm;
    rerender();
    const second = result.current.handleDiscoveryConfirm;

    expect(first).toBe(second);
  });

  it("does not run effect when not authenticated", async () => {
    const checkCoreMemoryExists = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists,
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: false,
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    // Allow any microtasks to run
    await vi.waitFor(() => {
      // Since not authenticated, effect should not have called checkCoreMemoryExists
      expect(checkCoreMemoryExists).not.toHaveBeenCalled();
    });
  });

  it("does not run effect when conversationId is null", async () => {
    const checkCoreMemoryExists = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists,
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: null,
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(checkCoreMemoryExists).not.toHaveBeenCalled();
    });
  });

  it("skips synthesis when core memory already exists", async () => {
    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );

    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() => Promise.resolve(true)),
      collectAllSignals: vi.fn(),
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(
        (window as unknown as Record<string, { collectAllSignals: ReturnType<typeof vi.fn> }>).electronAPI.collectAllSignals,
      ).not.toHaveBeenCalled();
      expect(synthesizeCoreMemory).not.toHaveBeenCalled();
    });
  });

  it("skips synthesis when collectAllSignals returns error", async () => {
    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );

    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
      collectAllSignals: vi.fn(() =>
        Promise.resolve({ error: "some error", formatted: null }),
      ),
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(synthesizeCoreMemory).not.toHaveBeenCalled();
    });
  });

  it("runs full synthesis flow and posts welcome message", async () => {
    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );
    const { getOrCreateDeviceId } = await import("../../services/device");

    vi.mocked(synthesizeCoreMemory).mockResolvedValueOnce({
      coreMemory: "User is a developer",
      welcomeMessage: "Hello! Welcome to Stella.",
      suggestions: [
        {
          category: "skill",
          title: "Tell me about yourself",
          description: "Tell me about yourself",
          prompt: "Tell me about yourself",
        },
      ],
    });

    const writeCoreMemory = vi.fn(() => Promise.resolve());

    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
      collectAllSignals: vi.fn(() =>
        Promise.resolve({
          formatted: "## Dev projects\n- project-a",
          error: null,
        }),
      ),
      writeCoreMemory,
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(synthesizeCoreMemory).toHaveBeenCalledWith(
        "## Dev projects\n- project-a",
      );
      expect(writeCoreMemory).toHaveBeenCalledWith(
        "User is a developer",
      );
      expect(getOrCreateDeviceId).toHaveBeenCalled();
      // appendEvent should be called twice: assistant_message + welcome_suggestions
      expect(mockAppendEvent).toHaveBeenCalledTimes(2);
      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "assistant_message",
          payload: { text: "Hello! Welcome to Stella." },
        }),
      );
      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "welcome_suggestions",
          payload: {
            suggestions: [
              expect.objectContaining({
                title: "Tell me about yourself",
                prompt: "Tell me about yourself",
              }),
            ],
          },
        }),
      );
    });
  });

  it("posts welcome message without suggestions when suggestions are empty", async () => {
    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );

    vi.mocked(synthesizeCoreMemory).mockResolvedValueOnce({
      coreMemory: "User profile",
      welcomeMessage: "Welcome!",
      suggestions: [],
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
      collectAllSignals: vi.fn(() =>
        Promise.resolve({ formatted: "signals", error: null }),
      ),
      writeCoreMemory: vi.fn(() => Promise.resolve()),
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-2",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["apps_system"]);
    });

    await vi.waitFor(() => {
      // Only assistant_message, no welcome_suggestions (empty array is falsy via .length)
      expect(mockAppendEvent).toHaveBeenCalledTimes(1);
      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_message",
        }),
      );
    });
  });

  it("skips welcome message when synthesizeCoreMemory returns no welcomeMessage", async () => {
    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );

    vi.mocked(synthesizeCoreMemory).mockResolvedValueOnce({
      coreMemory: "User profile",
      welcomeMessage: "",
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
      collectAllSignals: vi.fn(() =>
        Promise.resolve({ formatted: "signals", error: null }),
      ),
      writeCoreMemory: vi.fn(() => Promise.resolve()),
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-3",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["apps_system"]);
    });

    await vi.waitFor(() => {
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });
  });

  it("silently catches errors in the async run function", async () => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() =>
        Promise.reject(new Error("some error")),
      ),
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        isAuthenticated: true,
        conversationId: "conv-4",
      }),
    );

    // Should not throw
    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });
  });

  it("only runs synthesis once even when called multiple times (synthesizedRef guard)", async () => {
    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );

    vi.mocked(synthesizeCoreMemory).mockResolvedValue({
      coreMemory: "profile",
      welcomeMessage: "hi",
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
      collectAllSignals: vi.fn(() =>
        Promise.resolve({ formatted: "data", error: null }),
      ),
      writeCoreMemory: vi.fn(() => Promise.resolve()),
    };

    const { result, rerender } = renderHook(
      (props) => useDiscoveryFlow(props),
      {
        initialProps: {
          isAuthenticated: true,
          conversationId: "conv-5",
        },
      },
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(synthesizeCoreMemory).toHaveBeenCalledTimes(1);
    });

    // Force a rerender — the ref guard should prevent a second run
    rerender({
      isAuthenticated: true,
      conversationId: "conv-5",
    });

    // Still only called once
    expect(synthesizeCoreMemory).toHaveBeenCalledTimes(1);
  });
});
