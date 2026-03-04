import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDiscoveryFlow } from "./DiscoveryFlow";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockChatStoreAppendEvent = vi.fn(() => Promise.resolve({ _id: "event-123" }));
const mockSetCoreMemory = vi.fn(() => Promise.resolve(null));
const mockGetOrCreateDefaultConversation = vi.fn(() =>
  Promise.resolve({ _id: "conv-cloud-default" }),
);
const mockStartGeneration = vi.fn(() => Promise.resolve(null));

vi.mock("convex/react", () => ({
  useMutation: vi.fn((ref: string) => {
    if (ref === "setCoreMemory") return mockSetCoreMemory;
    if (ref === "getOrCreateDefaultConversation")
      return mockGetOrCreateDefaultConversation;
    return vi.fn();
  }),
  useAction: vi.fn(() => mockStartGeneration),
}));

const mockUseChatStore = vi.fn(() => ({
  storageMode: "cloud",
  isLocalStorage: false,
  cloudFeaturesEnabled: true,
  isAuthenticated: true,
  appendEvent: mockChatStoreAppendEvent,
  appendAgentEvent: vi.fn(),
  uploadAttachments: vi.fn(),
  buildHistory: vi.fn(),
}));

vi.mock("../../app/state/chat-store", () => ({
  useChatStore: () => mockUseChatStore(),
}));

vi.mock("../../convex/api", () => ({
  api: {
    events: { appendEvent: "appendEvent" },
    data: { preferences: { setCoreMemory: "setCoreMemory" } },
    conversations: {
      getOrCreateDefaultConversation: "getOrCreateDefaultConversation",
    },
    personalized_dashboard: { startGeneration: "startGeneration" },
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
    conversationId: null as string | null,
  };
}

function setCloudMode(isAuthenticated = true) {
  mockUseChatStore.mockReturnValue({
    storageMode: "cloud",
    isLocalStorage: false,
    cloudFeaturesEnabled: isAuthenticated,
    isAuthenticated,
    appendEvent: mockChatStoreAppendEvent,
    appendAgentEvent: vi.fn(),
    uploadAttachments: vi.fn(),
    buildHistory: vi.fn(),
    });
}

function setLocalMode(isAuthenticated = false) {
  mockUseChatStore.mockReturnValue({
    storageMode: "local",
    isLocalStorage: true,
    cloudFeaturesEnabled: false,
    isAuthenticated,
    appendEvent: mockChatStoreAppendEvent,
    appendAgentEvent: vi.fn(),
    uploadAttachments: vi.fn(),
    buildHistory: vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDiscoveryFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>).electronAPI;
    setCloudMode();
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
    setCloudMode(true);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });
  });

  it("prepends browsing_bookmarks when browser is selected in localStorage", () => {
    localStorage.setItem(BROWSER_SELECTION_KEY, "chrome");
    setCloudMode(true);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });
  });

  it("does not duplicate browsing_bookmarks if already in categories", () => {
    localStorage.setItem(BROWSER_SELECTION_KEY, "chrome");
    setCloudMode(true);

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

  it("does not run effect when not authenticated", async () => {
    const checkCoreMemoryExists = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: { checkCoreMemoryExists },
    };
    setCloudMode(false);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(checkCoreMemoryExists).not.toHaveBeenCalled();
    });
  });

  it("does not run effect when conversationId is null", async () => {
    const checkCoreMemoryExists = vi.fn();
    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: { checkCoreMemoryExists },
    };
    setCloudMode(true);

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
      "../../services/synthesis"
    );

    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(true)),
        collectAllSignals: vi.fn(),
      },
    };
    setCloudMode(true);

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
      "../../services/synthesis"
    );

    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ error: "some error", formatted: null }),
        ),
      },
    };
    setCloudMode(true);

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
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({
            formatted: "## Dev projects\n- project-a",
            error: null,
          }),
        ),
        writeCoreMemory,
      },
    };
    setCloudMode(true);

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
      expect(writeCoreMemory).toHaveBeenCalledWith(
        "User is a developer",
      );
      expect(getOrCreateDeviceId).toHaveBeenCalled();
      // chatStore.appendEvent should be called twice: assistant_message + welcome_suggestions
      expect(mockChatStoreAppendEvent).toHaveBeenCalledTimes(2);
      expect(mockChatStoreAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          type: "assistant_message",
          payload: { text: "Hello! Welcome to Stella." },
        }),
      );
      expect(mockChatStoreAppendEvent).toHaveBeenCalledWith(
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
      expect(mockStartGeneration).toHaveBeenCalledWith({
        conversationId: "conv-1",
        coreMemory: "User is a developer",
        targetDeviceId: "device-1",
        force: false,
      });
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
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ formatted: "signals", error: null }),
        ),
        writeCoreMemory: vi.fn(() => Promise.resolve()),
      },
    };
    setCloudMode(true);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-2",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["apps_system"]);
    });

    await vi.waitFor(() => {
      // Only assistant_message, no welcome_suggestions (empty array is falsy via .length)
      expect(mockChatStoreAppendEvent).toHaveBeenCalledTimes(1);
      expect(mockChatStoreAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_message",
        }),
      );
    });
  });

  it("starts generation in local mode when core memory is synthesized", async () => {
    setLocalMode(true);

    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
    );

    vi.mocked(synthesizeCoreMemory).mockResolvedValueOnce({
      coreMemory: "Local user profile",
      welcomeMessage: "",
    });

    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ formatted: "signals", error: null }),
        ),
        writeCoreMemory: vi.fn(() => Promise.resolve()),
      },
    };

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-local-1",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["apps_system"]);
    });

    await vi.waitFor(() => {
      expect(mockStartGeneration).toHaveBeenCalledWith({
        conversationId: "conv-cloud-default",
        coreMemory: "Local user profile",
        targetDeviceId: "device-1",
        force: true,
      });
    });
  });

  it("runs discovery synthesis in unauthenticated local mode", async () => {
    setLocalMode(false);

    const { synthesizeCoreMemory } = await import(
      "../../services/synthesis"
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
          Promise.resolve({ formatted: "local unauth signals", error: null }),
        ),
        writeCoreMemory,
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
      expect(mockStartGeneration).not.toHaveBeenCalled();
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
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ formatted: "signals", error: null }),
        ),
        writeCoreMemory: vi.fn(() => Promise.resolve()),
      },
    };
    setCloudMode(true);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-3",
      }),
    );

    act(() => {
      result.current.handleDiscoveryConfirm(["apps_system"]);
    });

    await vi.waitFor(() => {
      expect(mockChatStoreAppendEvent).not.toHaveBeenCalled();
    });
  });

  it("silently catches errors in the async run function", async () => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      browser: {
        checkCoreMemoryExists: vi.fn(() =>
          Promise.reject(new Error("some error")),
        ),
      },
    };
    setCloudMode(true);

    const { result } = renderHook(() =>
      useDiscoveryFlow({
        conversationId: "conv-4",
      }),
    );

    // Should not throw
    act(() => {
      result.current.handleDiscoveryConfirm(["dev_environment"]);
    });

    await vi.waitFor(() => {
      expect(mockChatStoreAppendEvent).not.toHaveBeenCalled();
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
      browser: {
        checkCoreMemoryExists: vi.fn(() => Promise.resolve(false)),
        collectAllSignals: vi.fn(() =>
          Promise.resolve({ formatted: "data", error: null }),
        ),
        writeCoreMemory: vi.fn(() => Promise.resolve()),
      },
    };

    const { result, rerender } = renderHook(
      (props) => useDiscoveryFlow(props),
      {
        initialProps: {
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
      conversationId: "conv-5",
    });

    // Still only called once
    expect(synthesizeCoreMemory).toHaveBeenCalledTimes(1);
  });
});
