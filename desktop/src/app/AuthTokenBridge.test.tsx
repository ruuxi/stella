import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthTokenBridge } from "./AuthTokenBridge";

const mockUseConvexAuth = vi.fn();
const mockUseAction = vi.fn();
vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
  useAction: () => mockUseAction(),
}));

const mockGetConvexToken = vi.fn();
vi.mock("@/services/auth-token", () => ({
  getConvexToken: () => mockGetConvexToken(),
}));

vi.mock("@/convex/api", () => ({
  api: {
    "agent/mint_proxy_token": {
      mintProxyToken: "agent/mint_proxy_token:mintProxyToken",
    },
  },
}));

describe("AuthTokenBridge", () => {
  let mockSetAuthState: ReturnType<typeof vi.fn>;
  let mockMintProxyToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetAuthState = vi.fn();
    mockMintProxyToken = vi.fn().mockResolvedValue({
      proxyToken: { token: "test-proxy-token" },
    });
    mockUseAction.mockReturnValue(mockMintProxyToken);
    mockGetConvexToken.mockResolvedValue("test-jwt-token");
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      setAuthState: mockSetAuthState,
      platform: "win32",
    };
  });

  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders nothing (returns null)", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    const { container } = render(<AuthTokenBridge />);
    expect(container.innerHTML).toBe("");
  });

  it("calls setAuthState with authenticated=true and proxy token when authenticated", async () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true, token: "test-proxy-token" });
    expect(mockMintProxyToken).toHaveBeenCalled();
  });

  it("calls setAuthState with authenticated=false when not authenticated", async () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });

  it("updates setAuthState when auth state changes", async () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });

    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    await act(async () => {
      result!.rerender(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true, token: "test-proxy-token" });
  });

  it("clears auth state on unmount", async () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<AuthTokenBridge />);
    });

    mockSetAuthState.mockClear();
    result!.unmount();
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });

  it("does not call setAuthState when electronAPI is absent", async () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("does not call setAuthState when setAuthState method is missing", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    // Should not throw and setAuthState should not be called
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("does not clear auth state on unmount when electronAPI is absent", async () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<AuthTokenBridge />);
    });
    result!.unmount();
    // Should not throw
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("falls back to Convex JWT when proxy token mint fails", async () => {
    mockMintProxyToken.mockRejectedValue(new Error("mint failed"));
    mockGetConvexToken.mockResolvedValue("fallback-jwt-token");
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true, token: "fallback-jwt-token" });
  });

  it("sends token as undefined when both mint and jwt fetch fail", async () => {
    mockMintProxyToken.mockRejectedValue(new Error("mint failed"));
    mockGetConvexToken.mockResolvedValue(null);
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true, token: undefined });
  });
});
