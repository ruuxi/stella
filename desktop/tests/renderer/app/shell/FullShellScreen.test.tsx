import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// --- Mocks ---

const mockAreLocalWorkspacePanelsEnabled = vi.fn(() => true);

const mockSendMessage = vi.fn();
const mockUseConversationEventFeed = vi.fn((conversationId?: string) => {
  void conversationId;
  return {
    events: [],
    hasOlderEvents: false,
    isLoadingOlder: false,
    isInitialLoading: false,
    loadOlder: vi.fn(),
  };
});
const mockUseStreamingChat = vi.fn((options?: unknown) => {
  void options;
  return {
    streamingText: "",
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null,
    queueNext: null,
    setQueueNext: vi.fn(),
    selfModMap: {},
    sendMessage: mockSendMessage,
    cancelCurrentStream: vi.fn(),
    syncWithEvents: vi.fn(),
    processFollowUpQueue: vi.fn(),
  };
});

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: true, isLoading: false })),
  useMutation: vi.fn(() => vi.fn()),
  useAction: vi.fn(() => vi.fn()),
  Authenticated: ({ children }: any) => <>{children}</>,
}));

const mockSetView = vi.fn();
vi.mock("@/context/ui-state", () => ({
  useUiState: vi.fn(() => ({
    state: { mode: "chat", window: "full", view: "home", conversationId: "conv-123" },
    setMode: vi.fn(),
    setView: mockSetView,
    setConversationId: vi.fn(),
    setWindow: vi.fn(),
    updateState: vi.fn(),
  })),
}));

const mockOpenPanel = vi.fn();
const mockClosePanel = vi.fn();
const mockSetChatWidth = vi.fn();
const mockSetChatOpen = vi.fn();
vi.mock("@/context/workspace-state", () => ({
  useWorkspace: vi.fn(() => ({
    state: { activePanel: null, chatWidth: 480, isChatOpen: true },
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
    setChatWidth: mockSetChatWidth,
    setChatOpen: mockSetChatOpen,
  })),
}));

vi.mock("@/context/theme-context", () => ({
  useTheme: vi.fn(() => ({
    theme: { id: "default", name: "Default" },
    themeId: "default",
    gradientMode: "soft",
    gradientColor: "relative",
    colors: {
      background: "#000000",
      foreground: "#ffffff",
      interactive: "#3b82f6",
      border: "#333333",
      card: "#111111",
      primaryForeground: "#ffffff",
      mutedForeground: "#999999",
    },
    setTheme: vi.fn(),
    colorMode: "dark",
    setColorMode: vi.fn(),
    resolvedColorMode: "dark",
    setGradientMode: vi.fn(),
    setGradientColor: vi.fn(),
    themes: [],
    previewTheme: vi.fn(),
    cancelThemePreview: vi.fn(),
    cancelPreview: vi.fn(),
  })),
}));

vi.mock("@/app/chat/hooks/use-conversation-events", () => ({
  useConversationEventFeed: (conversationId?: string) =>
    mockUseConversationEventFeed(conversationId),
}));

vi.mock("@/app/workspace/hooks/use-canvas-commands", () => ({
  useCanvasCommands: vi.fn(),
}));

vi.mock("@/platform/electron/electron", () => ({
  getElectronApi: vi.fn(() => undefined),
}));

vi.mock("@/shared/lib/local-workspace-panels", () => ({
  LOCAL_WORKSPACE_PANELS_DEV_ONLY_MESSAGE:
    "Local workspace panels are only available while running the Vite dev server.",
  areLocalWorkspacePanelsEnabled: () => mockAreLocalWorkspacePanelsEnabled(),
}));

vi.mock("@/global/auth/services/auth", () => ({
  secureSignOut: vi.fn(),
}));

vi.mock("@/platform/electron/device", () => ({
  getOrCreateDeviceId: vi.fn(() => Promise.resolve("device-1")),
}));

// Sub-components
vi.mock("@/shell/background/ShiftingGradient", () => ({
  ShiftingGradient: ({ mode, colorMode }: any) => (
    <div data-testid="shifting-gradient" data-mode={mode} data-color-mode={colorMode} />
  ),
}));

vi.mock("@/shell/TitleBar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}));

vi.mock("@/shell/sidebar/Sidebar", () => ({
  Sidebar: (props: any) => (
    <div data-testid="sidebar">
      <button data-testid="sidebar-store" onClick={props.onStore}>Store</button>
      <button data-testid="sidebar-home" onClick={props.onHome}>Home</button>
      <button data-testid="sidebar-signin" onClick={props.onSignIn}>Sign In</button>
      <button data-testid="sidebar-connect" onClick={props.onConnect}>Connect</button>
      <button data-testid="sidebar-settings" onClick={props.onSettings}>Settings</button>
      {props.storeActive && <span data-testid="store-active" />}
    </div>
  ),
}));

vi.mock("@/app/workspace/WorkspaceArea", () => ({
  WorkspaceArea: (props: any) => (
    <div data-testid="workspace-area" data-view={props.view} />
  ),
}));

vi.mock("@/shell/HeaderTabBar", () => ({
  HeaderTabBar: (props: any) => (
    <div data-testid="header-tab-bar" data-view={props.activeView}>
      {(props.pages ?? []).map((page: any) => (
        <button
          key={page.pageId}
          data-testid={`tab-page-${page.pageId}`}
          onClick={() => props.onTabSelect?.("app", page)}
        >
          {page.title}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/shell/FloatingOrb", () => ({
  FloatingOrb: () => <div data-testid="floating-orb" />,
}));

vi.mock("@/shell/hooks/use-orb-message", () => ({
  useOrbMessage: () => ({ text: null }),
}));

vi.mock("@/global/auth/AuthDialog", () => ({
  AuthDialog: ({ open }: any) =>
    open ? <div data-testid="auth-dialog" /> : null,
}));

vi.mock("@/global/integrations/ConnectDialog", () => ({
  ConnectDialog: ({ open }: any) =>
    open ? <div data-testid="connect-dialog" /> : null,
}));

vi.mock("@/global/settings/SettingsView", () => ({
  default: ({ open, onOpenChange, onSignOut }: any) =>
    open ? (
      <div data-testid="settings-dialog">
        <button data-testid="settings-close" onClick={() => onOpenChange(false)}>Close</button>
        <button data-testid="settings-signout" onClick={onSignOut}>Sign Out</button>
      </div>
    ) : null,
}));

vi.mock("@/app/chat/ChatColumn", () => ({
  ChatColumn: () => <div data-testid="chat-column" />,
}));

vi.mock("@/global/onboarding/OnboardingOverlay", () => ({
  useOnboardingOverlay: vi.fn(() => ({
    onboardingDone: true,
    onboardingExiting: false,
    completeOnboarding: vi.fn(),
    isAuthenticated: true,
    isAuthLoading: false,
    hasExpanded: false,
    splitMode: false,
    hasDiscoverySelections: false,
    setHasDiscoverySelections: vi.fn(),
    onboardingKey: "test",
    stellaAnimationRef: createRef(),
    triggerFlash: vi.fn(),
    startBirthAnimation: vi.fn(),
    handleEnterSplit: vi.fn(),
    handleResetOnboarding: vi.fn(),
  })),
  OnboardingView: () => <div data-testid="onboarding-view" />,
}));

vi.mock("@/global/onboarding/OnboardingCanvas", () => ({
  OnboardingCanvas: () => <div data-testid="onboarding-canvas" />,
}));

vi.mock("@/global/onboarding/DiscoveryFlow", () => ({
  useDiscoveryFlow: vi.fn(() => ({
    handleDiscoveryConfirm: vi.fn(),
  })),
}));

vi.mock("@/app/chat/hooks/use-streaming-chat", () => ({
  useStreamingChat: (options: unknown) => mockUseStreamingChat(options),
}));

vi.mock("@/shell/use-chat-scroll-management", () => ({
  useChatScrollManagement: vi.fn(() => ({
    scrollContainerRef: createRef(),
    setScrollContainerElement: vi.fn(),
    setContentElement: vi.fn(),
    hasScrollElement: false,
    isNearBottom: true,
    isNearBottomRef: { current: true },
    showScrollButton: false,
    scrollToBottom: vi.fn(),
    handleScroll: vi.fn(),
    resetScrollState: vi.fn(),
    overflowAnchor: "none",
    thumbState: { top: 0, height: 0, visible: false },
  })),
}));

import { FullShell } from "@/shell/FullShell";
import { useUiState } from "@/context/ui-state";
import { getElectronApi } from "@/platform/electron/electron";

// --- Tests ---

describe("FullShell (full-shell/FullShell.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAreLocalWorkspacePanelsEnabled.mockReturnValue(true);
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "home", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);
    vi.mocked(getElectronApi).mockReturnValue(undefined);
  });

  it("renders TitleBar", () => {
    render(<FullShell />);
    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
  });

  it("renders ShiftingGradient", () => {
    render(<FullShell />);
    expect(screen.getByTestId("shifting-gradient")).toBeInTheDocument();
  });

  it("renders Sidebar", () => {
    render(<FullShell />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });

  it("renders WorkspaceArea and HeaderTabBar in home view", () => {
    render(<FullShell />);
    expect(screen.getByTestId("workspace-area")).toBeInTheDocument();
    expect(screen.getByTestId("header-tab-bar")).toBeInTheDocument();
    expect(screen.getByTestId("floating-orb")).toBeInTheDocument();
  });

  it("passes conversationId to useConversationEventFeed", () => {
    render(<FullShell />);
    expect(mockUseConversationEventFeed).toHaveBeenCalledWith("conv-123");
  });

  it("passes conversationId to useStreamingChat without storageMode", () => {
    render(<FullShell />);
    expect(mockUseStreamingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-123",
      }),
    );
    // storageMode is no longer passed â€” it comes from ChatStoreProvider
    const args = mockUseStreamingChat.mock.calls[0][0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("storageMode");
  });

  it("opens auth dialog when sidebar sign-in is clicked", async () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-signin"));
    expect(await screen.findByTestId("auth-dialog")).toBeInTheDocument();
  });

  it("opens connect dialog when sidebar connect is clicked", async () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-connect"));
    expect(await screen.findByTestId("connect-dialog")).toBeInTheDocument();
  });

  it("opens settings dialog when sidebar settings is clicked", async () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeInTheDocument();
  });

  it("navigates home via sidebar onHome", () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-home"));
    expect(mockSetView).toHaveBeenCalledWith("home");
  });

  it("routes stella:send-message events to sendMessage", () => {
    render(<FullShell />);
    window.dispatchEvent(
      new CustomEvent("stella:send-message", { detail: { text: "Ping from home" } }),
    );
    expect(mockSendMessage).toHaveBeenCalledWith({
      text: "Ping from home",
      selectedText: null,
      chatContext: null,
      onClear: expect.any(Function),
    });
  });

  it("renders the shell with correct base class", () => {
    const { container } = render(<FullShell />);
    const shell = container.querySelector(".window-shell.full");
    expect(shell).toBeInTheDocument();
  });

  it("shows and opens local workspace pages via tab bar when cloud pages are unavailable", async () => {
    const listWorkspacePanels = vi.fn(() =>
      Promise.resolve([{ name: "pd_focus", title: "Focus" }]),
    );

    vi.mocked(getElectronApi).mockReturnValue({
      browser: { listWorkspacePanels },
      capture: { getContext: vi.fn().mockResolvedValue(null), onContext: vi.fn(() => vi.fn()) },
    } as any);

    render(<FullShell />);
    const pageButton = await screen.findByTestId("tab-page-local_panel:pd_focus");
    fireEvent.click(pageButton);

    expect(listWorkspacePanels).toHaveBeenCalled();
    expect(mockOpenPanel).toHaveBeenCalledWith({ name: "pd_focus", title: "Focus" });
    expect(mockSetView).toHaveBeenCalledWith("app");
  });

  it("does not list local workspace pages outside dev mode", () => {
    mockAreLocalWorkspacePanelsEnabled.mockReturnValue(false);
    const listWorkspacePanels = vi.fn(() =>
      Promise.resolve([{ name: "pd_focus", title: "Focus" }]),
    );

    vi.mocked(getElectronApi).mockReturnValue({
      browser: { listWorkspacePanels },
      capture: { getContext: vi.fn().mockResolvedValue(null), onContext: vi.fn(() => vi.fn()) },
    } as any);

    render(<FullShell />);

    expect(screen.queryByTestId("tab-page-local_panel:pd_focus")).not.toBeInTheDocument();
    expect(listWorkspacePanels).not.toHaveBeenCalled();
  });
});





