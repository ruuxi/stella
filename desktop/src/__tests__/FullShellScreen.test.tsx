import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// --- Mocks ---

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
    state: { mode: "chat", window: "full", view: "chat", conversationId: "conv-123" },
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
  useConversationEvents: vi.fn(() => []),
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

vi.mock("@/convex/api", () => ({
  api: {
    data: {
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

vi.mock("../components/chat/ChatPanel", () => ({
  ChatPanel: ({ children }: any) => (
    <div data-testid="chat-panel">{children}</div>
  ),
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
  useStreamingChat: vi.fn(() => ({
    streamingText: "",
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null,
    queueNext: null,
    setQueueNext: vi.fn(),
    sendMessage: vi.fn(),
    syncWithEvents: vi.fn(),
    processFollowUpQueue: vi.fn(),
  })),
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

// --- Tests ---

describe("FullShell (full-shell/FullShell.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "chat", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);
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

  it("renders WorkspaceArea and ChatPanel in chat view", () => {
    render(<FullShell />);
    expect(screen.getByTestId("workspace-area")).toBeInTheDocument();
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
    expect(screen.getByTestId("chat-column")).toBeInTheDocument();
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
    // Chat panel is still visible alongside store
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
  });

  it("toggles store view via sidebar onStore", () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-store"));
    expect(mockSetView).toHaveBeenCalledWith("store");
  });

  it("toggles back to chat view via sidebar onStore when already in store", () => {
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
    expect(mockSetView).toHaveBeenCalledWith("chat");
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
    expect(mockSetView).toHaveBeenCalledWith("chat");
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

  it("renders the shell with correct base class", () => {
    const { container } = render(<FullShell />);
    const shell = container.querySelector(".window-shell.full");
    expect(shell).toBeInTheDocument();
  });
});
