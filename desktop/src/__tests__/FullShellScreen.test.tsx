import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// --- Mocks ---
// vi.mock paths are resolved relative to THIS test file (src/__tests__)

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
const mockSetWidth = vi.fn();
vi.mock("../app/state/canvas-state", () => ({
  useCanvas: vi.fn(() => ({
    state: { isOpen: false, canvas: null, width: 560 },
    openCanvas: mockOpenCanvas,
    closeCanvas: mockCloseCanvas,
    setWidth: mockSetWidth,
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

vi.mock("../components/canvas/CanvasPanel", () => ({
  CanvasPanel: () => <div data-testid="canvas-panel" />,
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

// Lazy-loaded components from within screens/full-shell/
vi.mock("../screens/full-shell/StoreView", () => ({
  default: ({ onBack }: any) => (
    <div data-testid="store-view">
      <button data-testid="store-back" onClick={onBack}>Back</button>
    </div>
  ),
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

vi.mock("../components/onboarding/OnboardingCanvas", () => ({
  OnboardingCanvas: () => <div data-testid="onboarding-canvas" />,
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
import { useCanvas } from "../app/state/canvas-state";

// --- Tests ---

describe("FullShell (full-shell/FullShell.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "chat", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);

    vi.mocked(useCanvas).mockReturnValue({
      state: { isOpen: false, canvas: null, width: 560 },
      openCanvas: mockOpenCanvas,
      closeCanvas: mockCloseCanvas,
      setWidth: mockSetWidth,
    });
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

  it("renders ChatColumn in chat view", () => {
    render(<FullShell />);
    expect(screen.getByTestId("chat-column")).toBeInTheDocument();
    expect(screen.queryByTestId("store-view")).not.toBeInTheDocument();
  });

  it("renders StoreView when view is store", async () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "store", conversationId: "conv-123" },
      setMode: vi.fn(),
      setView: mockSetView,
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);

    render(<FullShell />);
    // StoreView is lazy-loaded, so wait for it
    expect(await screen.findByTestId("store-view")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-column")).not.toBeInTheDocument();
  });

  it("toggles store view via sidebar onStore", () => {
    render(<FullShell />);
    fireEvent.click(screen.getByTestId("sidebar-store"));
    // Should call setView with 'store' (since current view is 'chat')
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

  it("does not render CanvasPanel when canvas is closed", () => {
    render(<FullShell />);
    expect(screen.queryByTestId("canvas-panel")).not.toBeInTheDocument();
  });

  it("renders CanvasPanel when canvas is open", () => {
    vi.mocked(useCanvas).mockReturnValue({
      state: { isOpen: true, canvas: { name: "test-panel" }, width: 560 },
      openCanvas: mockOpenCanvas,
      closeCanvas: mockCloseCanvas,
      setWidth: mockSetWidth,
    });

    render(<FullShell />);
    expect(screen.getByTestId("canvas-panel")).toBeInTheDocument();
  });

  it("applies has-canvas class when canvas is open", () => {
    vi.mocked(useCanvas).mockReturnValue({
      state: { isOpen: true, canvas: { name: "test-panel" }, width: 560 },
      openCanvas: mockOpenCanvas,
      closeCanvas: mockCloseCanvas,
      setWidth: mockSetWidth,
    });

    const { container } = render(<FullShell />);
    const shell = container.querySelector(".window-shell");
    expect(shell?.className).toContain("has-canvas");
  });

  it("does not apply has-canvas class when canvas is closed", () => {
    const { container } = render(<FullShell />);
    const shell = container.querySelector(".window-shell");
    expect(shell?.className).not.toContain("has-canvas");
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
    // SettingsDialog is lazy-loaded
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

  it("sets canvas width CSS variable when canvas is open", () => {
    vi.mocked(useCanvas).mockReturnValue({
      state: { isOpen: true, canvas: { name: "test" }, width: 700 },
      openCanvas: mockOpenCanvas,
      closeCanvas: mockCloseCanvas,
      setWidth: mockSetWidth,
    });

    const { container } = render(<FullShell />);
    const shell = container.querySelector(".window-shell") as HTMLElement;
    expect(shell.style.getPropertyValue("--canvas-panel-width")).toBe("700px");
  });

  it("renders the shell with correct base class", () => {
    const { container } = render(<FullShell />);
    const shell = container.querySelector(".window-shell.full");
    expect(shell).toBeInTheDocument();
  });

  it("auto-opens dashboard when authenticated and onboarding done", () => {
    // The FullShell effect auto-opens dashboard when conditions are met
    // and no canvas is open and dashboard is not dismissed
    render(<FullShell />);
    // openCanvas should be called with dashboard since onboarding is done,
    // user is authenticated, and no canvas is open
    expect(mockOpenCanvas).toHaveBeenCalledWith({ name: "dashboard" });
  });
});
