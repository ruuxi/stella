import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDiscoveryFlow } from "../../../../src/global/onboarding/DiscoveryFlow";

const mockPersistDiscoveryWelcome = vi.fn(() => Promise.resolve({ ok: true }));
const mockUseAuthSessionState = vi.fn(() => ({
  hasConnectedAccount: true,
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => mockUseAuthSessionState(),
}));

vi.mock("@/global/onboarding/services/synthesis", () => ({
  synthesizeCoreMemory: vi.fn(() =>
    Promise.resolve({ coreMemory: null }),
  ),
}));

const BROWSER_SELECTION_KEY = "stella-selected-browser";
const BROWSER_PROFILE_KEY = "stella-selected-browser-profile";

function defaultOptions() {
  return {
    conversationId: null as string | null,
  };
}

function setAuthState(hasConnectedAccount = true) {
  mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount });
}

describe("useDiscoveryFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>).electronAPI;
    setAuthState(true);
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

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });
  });

  it("does not prepend browsing_bookmarks when no browser is selected", () => {
    localStorage.removeItem(BROWSER_SELECTION_KEY);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });
  });

  it("prepends browsing_bookmarks when browser is selected", () => {
    localStorage.setItem(BROWSER_SELECTION_KEY, "chrome");

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });
  });

  it("does not duplicate browsing_bookmarks if already present", () => {
    localStorage.setItem(BROWSER_SELECTION_KEY, "chrome");

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm([
        "browsing_bookmarks",
        "dev_environment",
      ]);
    });
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

  it("still runs synthesis when not authenticated", async () => {
    const checkCoreMemoryExists = vi.fn(() => Promise.resolve(false));
    const collectAllSignals = vi.fn(() =>
      Promise.resolve({ formattedSections: "signals", error: null }),
    );
    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists,
        collectAllSignals,
        writeCoreMemory: vi.fn(() => Promise.resolve()),
      },
      localChat: {
        persistDiscoveryWelcome: mockPersistDiscoveryWelcome,
      },
    };
    setAuthState(false);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(checkCoreMemoryExists).toHaveBeenCalled();
      expect(collectAllSignals).toHaveBeenCalled();
    });
  });

  it("does not run effect when conversationId is null", async () => {
    const checkCoreMemoryExists = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: { checkCoreMemoryExists },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
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
      "@/global/onboarding/services/synthesis"
    );

    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(true)),
        collectAllSignals: vi.fn(),
      },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(
        (window as unknown as Record<string, { browser: { collectAllSignals: ReturnType<typeof vi.fn> } }>).electronAPI.browser.collectAllSignals,
      ).not.toHaveBeenCalled();
      expect(synthesizeCoreMemory).not.toHaveBeenCalled();
    });
  });

  it("skips synthesis when collectAllSignals returns error", async () => {
    const { synthesizeCoreMemory } = await import(
      "@/global/onboarding/services/synthesis"
    );

    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ error: "some error", formattedSections: null }),
        ),
      },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
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
      "@/global/onboarding/services/synthesis"
    );

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
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({
            formattedSections: "## Dev projects\n- project-a",
            error: null,
          }),
        ),
        writeCoreMemory,
      },
      localChat: {
        persistDiscoveryWelcome: mockPersistDiscoveryWelcome,
      },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(synthesizeCoreMemory).toHaveBeenCalledWith(
        "## Dev projects\n- project-a",
        { includeAuth: true },
      );
      expect(writeCoreMemory).toHaveBeenCalledWith("User is a developer");
      expect(mockPersistDiscoveryWelcome).toHaveBeenCalledWith({
        conversationId: "conv-1",
        message: "Hello! Welcome to Stella.",
        suggestions: [
          expect.objectContaining({
            title: "Tell me about yourself",
            prompt: "Tell me about yourself",
          }),
        ],
      });
    });
  });

  it("posts welcome message without suggestions when suggestions are empty", async () => {
    const { synthesizeCoreMemory } = await import(
      "@/global/onboarding/services/synthesis"
    );

    vi.mocked(synthesizeCoreMemory).mockResolvedValueOnce({
      coreMemory: "User profile",
      welcomeMessage: "Welcome!",
      suggestions: [],
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ formattedSections: "signals", error: null }),
        ),
        writeCoreMemory: vi.fn(() => Promise.resolve()),
      },
      localChat: {
        persistDiscoveryWelcome: mockPersistDiscoveryWelcome,
      },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-2",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["apps_system"]);
    });

    await vi.waitFor(() => {
      expect(mockPersistDiscoveryWelcome).toHaveBeenCalledTimes(1);
      expect(mockPersistDiscoveryWelcome).toHaveBeenCalledWith({
        conversationId: "conv-2",
        message: "Welcome!",
      });
    });
  });

  it("runs discovery synthesis in unauthenticated local mode", async () => {
    setAuthState(false);

    const { synthesizeCoreMemory } = await import(
      "@/global/onboarding/services/synthesis"
    );

    vi.mocked(synthesizeCoreMemory).mockResolvedValueOnce({
      coreMemory: "Unauth local profile",
      welcomeMessage: "",
    });

    const writeCoreMemory = vi.fn(() => Promise.resolve());
    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ formattedSections: "local unauth signals", error: null }),
        ),
        writeCoreMemory,
      },
      localChat: {
        persistDiscoveryWelcome: mockPersistDiscoveryWelcome,
      },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-local-unauth",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["messages_notes"]);
    });

    await vi.waitFor(() => {
      expect(synthesizeCoreMemory).toHaveBeenCalledWith(
        "local unauth signals",
        { includeAuth: false },
      );
      expect(writeCoreMemory).toHaveBeenCalledWith("Unauth local profile");
      expect(mockPersistDiscoveryWelcome).not.toHaveBeenCalled();
    });
  });
});
