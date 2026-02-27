import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { useQuery } from "convex/react";

// --- Mocks ---

const mockSendMessage = vi.fn();
const mockUseConversationEvents = vi.fn((..._args: unknown[]) => []);
const mockUseStreamingChat = vi.fn((_options?: unknown) => ({
  streamingText: "",
  reasoningText: "",
  isStreaming: false,
  pendingUserMessageId: null,
  queueNext: null,
  setQueueNext: vi.fn(),
  selfModMap: {},
  sendMessage: mockSendMessage,
  syncWithEvents: vi.fn(),
  processFollowUpQueue: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: true, isLoading: false })),
  useQuery: vi.fn(() => undefined),
  useMutation: vi.fn(() => vi.fn()),
  useAction: vi.fn(() => vi.fn()),
  Authenticated: ({ children }: any) => <>{children}</>,
}));

const mockSetView = vi.fn();
vi.mock("../app/state/ui-state", () => ({
  useUiState: vi.fn(() => ({
    state: { mode: "chat", window: "full", view: "home", conversationId: "conv-123" },
    setMode: vi.fn(),
    setView: mockSetView,
    setConversationId: vi.fn(),
    setWindow: vi.fn(),
    updateState: vi.fn(),
  })),
}));

const mockOpenCanvas = vi.fn();
const mockCloseCanvas = vi.fn();
const mockSetChatWidth = vi.fn();
const mockSetChatOpen = vi.fn();
vi.mock("../app/state/workspace-state", () => ({
  useWorkspace: vi.fn(() => ({
    state: { canvas: null, chatWidth: 480, isChatOpen: true },
    openCanvas: mockOpenCanvas,
    closeCanvas: mockCloseCanvas,
    setChatWidth: mockSetChatWidth,
    setChatOpen: mockSetChatOpen,
  })),
}));

vi.mock("../theme/theme-context", () => ({
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

vi.mock("../hooks/use-conversation-events", () => ({
  useConversationEvents: (conversationId?: string, options?: { source?: "cloud" | "local" }) =>
    mockUseConversationEvents(conversationId, options),
}));

vi.mock("../hooks/use-canvas-commands", () => ({
  useCanvasCommands: vi.fn(),
}));

vi.mock("../services/electron", () => ({
  getElectronApi: vi.fn(() => undefined),
}));

vi.mock("../services/auth", () => ({
  secureSignOut: vi.fn(),
}));

vi.mock("../services/device", () => ({
  getOrCreateDeviceId: vi.fn(() => Promise.resolve("device-1")),
}));

vi.mock("@/convex/api", () => ({
  api: {
    personalized_dashboard: {
      listPages: "personalized_dashboard:listPages",
    },
    data: {
      preferences: {
        getAccountMode: "preferences:getAccountMode",
        getSyncMode: "preferences:getSyncMode",
      },
      canvas_states: {
        getForConversation: "canvas_states:getForConversation",
      },
    },
  },
}));

vi.mock("../hooks/use-bridge-reconnect", () => ({
  useBridgeAutoReconnect: vi.fn(),
}));

// Sub-components
vi.mock("../components/background/ShiftingGradient", () => ({
  ShiftingGradient: ({ mode, colorMode }: any) => (
    <div data-testid="shifting-gradient" data-mode={mode} data-color-mode={colorMode} />
  ),
}));

vi.mock("../components/TitleBar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}));

vi.mock("../components/Sidebar", () => ({
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

vi.mock("../components/workspace/WorkspaceArea", () => ({
  WorkspaceArea: (props: any) => (
    <div data-testid="workspace-area" data-view={props.view} />
  ),
}));

vi.mock("../components/header/HeaderTabBar", () => ({
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

vi.mock("../components/orb/FloatingOrb", () => ({
  FloatingOrb: () => <div data-testid="floating-orb" />,
}));

vi.mock("../hooks/use-orb-message", () => ({
  useOrbMessage: () => ({ text: null, opacity: 0 }),
}));

vi.mock("../app/AuthDialog", () => ({
  AuthDialog: ({ open }: any) =>
    open ? <div data-testid="auth-dialog" /> : null,
}));

vi.mock("../app/ConnectDialog", () => ({
  ConnectDialog: ({ open }: any) =>
    open ? <div data-testid="connect-dialog" /> : null,
}));

vi.mock("../app/RuntimeModeDialog", () => ({
  RuntimeModeDialog: ({ open }: any) =>
    open ? <div data-testid="runtime-mode-dialog" /> : null,
}));

vi.mock("../screens/full-shell/SettingsView", () => ({
  default: ({ open, onOpenChange, onSignOut }: any) =>
    open ? (
      <div data-testid="settings-dialog">
        <button data-testid="settings-close" onClick={() => onOpenChange(false)}>Close</button>
        <button data-testid="settings-signout" onClick={onSignOut}>Sign Out</button>
      </div>
    ) : null,
}));

vi.mock("../screens/full-shell/ChatColumn", () => ({
  ChatColumn: () => <div data-testid="chat-column" />,
}));

vi.mock("../screens/full-shell/OnboardingOverlay", () => ({
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
}));

vi.mock("../screens/full-shell/DiscoveryFlow", () => ({
  useDiscoveryFlow: vi.fn(() => ({
    handleDiscoveryConfirm: vi.fn(),
  })),
}));

vi.mock("../screens/full-shell/use-streaming-chat", () => ({
  useStreamingChat: (options: unknown) => mockUseStreamingChat(options),
}));

vi.mock("../screens/full-shell/use-full-shell", () => ({
  useScrollManagement: vi.fn(() => ({
    scrollContainerRef: createRef(),
    isNearBottom: true,
    showScrollButton: false,
    scrollToBottom: vi.fn(),
    handleScroll: vi.fn(),
  })),
}));

import { FullShell } from "../screens/full-shell/FullShell";
import { useUiState } from "../app/state/ui-state";
import { getElectronApi } from "../services/electron";

// --- Tests ---

describe("FullShell (full-shell/FullShell.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useQuery).mockImplementation((ref: unknown, args?: unknown) => {
      if (args === "skip") return undefined;
      if (ref === "preferences:getAccountMode") return "connected";
      if (ref === "preferences:getSyncMode") return "on";
      return undefined;
    });
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

  it("passes store view to WorkspaceArea", async () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "store", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);

    render(<FullShell />);
    const workspace = screen.getByTestId("workspace-area");
    expect(workspace).toHaveAttribute("data-view", "store");
  });

  it("uses local conversation storage when connected mode has sync off", () => {
    vi.mocked(useQuery).mockImplementation((ref: unknown, args?: unknown) => {
      if (args === "skip") return undefined;
      if (ref === "preferences:getAccountMode") return "connected";
      if (ref === "preferences:getSyncMode") return "off";
      return undefined;
    });

    render(<FullShell />);
    expect(mockUseConversationEvents).toHaveBeenCalledWith("conv-123", { source: "local" });
    expect(mockUseStreamingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-123",
        storageMode: "local",
      }),
    );
  });

  it("uses local conversation storage when account mode is private_local", () => {
    vi.mocked(useQuery).mockImplementation((ref: unknown, args?: unknown) => {
      if (args === "skip") return undefined;
      if (ref === "preferences:getAccountMode") return "private_local";
      if (ref === "preferences:getSyncMode") return "on";
      return undefined;
    });

    render(<FullShell />);
    expect(mockUseConversationEvents).toHaveBeenCalledWith("conv-123", { source: "local" });
    expect(mockUseStreamingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-123",
        storageMode: "local",
      }),
    );
  });

  it("toggles store view via sidebar onStore", () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-store"));
    expect(mockSetView).toHaveBeenCalledWith("store");
  });

  it("toggles back to home view via sidebar onStore when already in store", () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "store", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);

    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-store"));
    expect(mockSetView).toHaveBeenCalledWith("home");
  });

  it("opens auth dialog when sidebar sign-in is clicked", () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-signin"));
    expect(screen.getByTestId("auth-dialog")).toBeInTheDocument();
  });

  it("opens connect dialog when sidebar connect is clicked", () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-connect"));
    expect(screen.getByTestId("connect-dialog")).toBeInTheDocument();
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

  it("passes storeActive=true to Sidebar when view is store", () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "store", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);

    render(<FullShell />);
    expect(screen.getByTestId("store-active")).toBeInTheDocument();
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
    vi.mocked(useQuery).mockImplementation((ref: unknown, args?: unknown) => {
      if (args === "skip") return undefined;
      if (ref === "preferences:getAccountMode") return "private_local";
      if (ref === "preferences:getSyncMode") return "off";
      return undefined;
    });

    const listWorkspacePanels = vi.fn(() =>
      Promise.resolve([{ name: "pd_focus", title: "Focus" }]),
    );

    vi.mocked(getElectronApi).mockReturnValue({
      listWorkspacePanels,
    } as any);

    render(<FullShell />);
    const pageButton = await screen.findByTestId("tab-page-local_panel:pd_focus");
    fireEvent.click(pageButton);

    expect(listWorkspacePanels).toHaveBeenCalled();
    expect(mockOpenCanvas).toHaveBeenCalledWith({ name: "pd_focus", title: "Focus" });
    expect(mockSetView).toHaveBeenCalledWith("app");
  });
});
