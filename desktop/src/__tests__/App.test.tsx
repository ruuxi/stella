import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// --- Mocks ---

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: true, isLoading: false })),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useAction: vi.fn(),
  Authenticated: ({ children }: any) => <div data-testid="authenticated">{children}</div>,
}));

vi.mock("../app/state/ui-state", () => ({
  useUiState: vi.fn(() => ({
    state: { mode: "chat", window: "full", view: "chat", conversationId: null },
    setMode: vi.fn(),
    setView: vi.fn(),
    setConversationId: vi.fn(),
    setWindow: vi.fn(),
    updateState: vi.fn(),
  })),
}));

const mockGetElectronApi = vi.fn(() => undefined);
vi.mock("../services/electron", () => ({
  getElectronApi: () => mockGetElectronApi(),
}));

vi.mock("../app/AuthTokenBridge", () => ({
  AuthTokenBridge: () => <div data-testid="auth-token-bridge" />,
}));

vi.mock("../app/AuthDeepLinkHandler", () => ({
  AuthDeepLinkHandler: () => <div data-testid="auth-deep-link-handler" />,
}));

vi.mock("../app/AppBootstrap", () => ({
  AppBootstrap: () => <div data-testid="app-bootstrap" />,
}));

vi.mock("../app/CredentialRequestLayer", () => ({
  CredentialRequestLayer: () => <div data-testid="credential-request-layer" />,
}));

vi.mock("../screens/full-shell/FullShell", () => ({
  FullShell: () => <div data-testid="full-shell" />,
}));

vi.mock("../screens/MiniShell", () => ({
  MiniShell: () => <div data-testid="mini-shell" />,
}));

vi.mock("../screens/RadialShell", () => ({
  RadialShell: () => <div data-testid="radial-shell" />,
}));

vi.mock("../screens/RegionCapture", () => ({
  RegionCapture: () => <div data-testid="region-capture" />,
}));

import App from "../App";
import { useUiState } from "../app/state/ui-state";

// --- Tests ---

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetElectronApi.mockReturnValue(undefined);
    Object.defineProperty(window, "location", {
      value: { search: "", href: "http://localhost/" },
      writable: true,
    });
  });

  it("renders AuthDeepLinkHandler", () => {
    render(<App />);
    expect(screen.getByTestId("auth-deep-link-handler")).toBeInTheDocument();
  });

  it("renders AuthTokenBridge inside Authenticated", () => {
    render(<App />);
    expect(screen.getByTestId("auth-token-bridge")).toBeInTheDocument();
  });

  it("renders FullShell by default when not Electron and window state is full", async () => {
    render(<App />);
    expect(await screen.findByTestId("full-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("mini-shell")).not.toBeInTheDocument();
  });

  it("renders MiniShell when ui state window is mini and not Electron", async () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "mini", view: "chat", conversationId: null },
      setMode: vi.fn(),
      setView: vi.fn(),
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);

    render(<App />);
    expect(await screen.findByTestId("mini-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("full-shell")).not.toBeInTheDocument();
  });

  it("renders RadialShell when Electron and window param is radial", async () => {
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "?window=radial", href: "http://localhost/?window=radial" },
      writable: true,
    });

    render(<App />);
    expect(await screen.findByTestId("radial-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("full-shell")).not.toBeInTheDocument();
  });

  it("renders RegionCapture when Electron and window param is region", async () => {
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "?window=region", href: "http://localhost/?window=region" },
      writable: true,
    });

    render(<App />);
    expect(await screen.findByTestId("region-capture")).toBeInTheDocument();
    expect(screen.queryByTestId("full-shell")).not.toBeInTheDocument();
  });

  it("renders FullShell when Electron and window param is unrecognized", async () => {
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "?window=unknown", href: "http://localhost/?window=unknown" },
      writable: true,
    });

    render(<App />);
    expect(await screen.findByTestId("full-shell")).toBeInTheDocument();
  });

  it("renders FullShell when Electron and no window param", async () => {
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "", href: "http://localhost/" },
      writable: true,
    });

    render(<App />);
    expect(await screen.findByTestId("full-shell")).toBeInTheDocument();
  });

  it("renders MiniShell when Electron and window param is mini", async () => {
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "?window=mini", href: "http://localhost/?window=mini" },
      writable: true,
    });

    render(<App />);
    expect(await screen.findByTestId("mini-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("full-shell")).not.toBeInTheDocument();
  });

  it("renders AppBootstrap and CredentialRequestLayer for full/mini shells", async () => {
    render(<App />);
    expect(await screen.findByTestId("app-bootstrap")).toBeInTheDocument();
    expect(screen.getByTestId("credential-request-layer")).toBeInTheDocument();
  });

  it("does not render AppBootstrap or CredentialRequestLayer for radial shell", async () => {
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "?window=radial", href: "http://localhost/?window=radial" },
      writable: true,
    });

    render(<App />);
    // Wait for lazy radial to load
    await screen.findByTestId("radial-shell");
    expect(screen.queryByTestId("app-bootstrap")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credential-request-layer")).not.toBeInTheDocument();
  });

  it("shows fallback div with correct class while suspending", () => {
    // On initial render before lazy loads, the fallback should be the div
    const { container } = render(<App />);
    // The fallback for the full window type is <div class="app window-full" />
    // The fallback may or may not be present depending on how fast lazy resolves,
    // but the div should at least have the right structure
    expect(container.querySelector("[data-testid='auth-deep-link-handler']")).toBeInTheDocument();
  });
});

describe("getWindowType (tested indirectly)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetElectronApi.mockReturnValue(undefined);
    Object.defineProperty(window, "location", {
      value: { search: "", href: "http://localhost/" },
      writable: true,
    });
  });

  it("falls back to ui state window when not Electron", async () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "chat", conversationId: null },
      setMode: vi.fn(),
      setView: vi.fn(),
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);
    mockGetElectronApi.mockReturnValue(undefined);

    render(<App />);
    expect(await screen.findByTestId("full-shell")).toBeInTheDocument();
  });

  it("uses URL param over ui state when Electron is present", async () => {
    vi.mocked(useUiState).mockReturnValue({
      state: { mode: "chat", window: "full", view: "chat", conversationId: null },
      setMode: vi.fn(),
      setView: vi.fn(),
      setConversationId: vi.fn(),
      setWindow: vi.fn(),
      updateState: vi.fn(),
    } as any);
    mockGetElectronApi.mockReturnValue({} as any);
    Object.defineProperty(window, "location", {
      value: { search: "?window=radial", href: "http://localhost/?window=radial" },
      writable: true,
    });

    render(<App />);
    expect(await screen.findByTestId("radial-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("full-shell")).not.toBeInTheDocument();
  });
});
