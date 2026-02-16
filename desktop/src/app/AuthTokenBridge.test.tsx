import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthTokenBridge } from "./AuthTokenBridge";

const mockUseConvexAuth = vi.fn();
vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
}));

describe("AuthTokenBridge", () => {
  let mockSetAuthState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetAuthState = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      setAuthState: mockSetAuthState,
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

  it("calls setAuthState with authenticated=true when authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    render(<AuthTokenBridge />);
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true });
  });

  it("calls setAuthState with authenticated=false when not authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    render(<AuthTokenBridge />);
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });

  it("updates setAuthState when auth state changes", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    const { rerender } = render(<AuthTokenBridge />);
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });

    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    rerender(<AuthTokenBridge />);
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true });
  });

  it("clears auth state on unmount", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    const { unmount } = render(<AuthTokenBridge />);

    mockSetAuthState.mockClear();
    unmount();
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });

  it("does not call setAuthState when electronAPI is absent", () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    render(<AuthTokenBridge />);
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("does not call setAuthState when setAuthState method is missing", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    render(<AuthTokenBridge />);
    // Should not throw and setAuthState should not be called
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("does not clear auth state on unmount when electronAPI is absent", () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    const { unmount } = render(<AuthTokenBridge />);
    unmount();
    // Should not throw
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });
});
