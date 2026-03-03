import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthTokenBridge } from "./AuthTokenBridge";

const mockUseSession = vi.fn();

const mockGetConvexToken = vi.fn();
vi.mock("@/services/auth-token", () => ({
  getConvexToken: () => mockGetConvexToken(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => mockUseSession(),
  },
}));

describe("AuthTokenBridge", () => {
  let mockSetAuthState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSetAuthState = vi.fn();
    mockUseSession.mockReturnValue({ data: { id: "user-1" }, isPending: false });
    mockGetConvexToken.mockResolvedValue("test-jwt-token");
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      setAuthState: mockSetAuthState,
      platform: "win32",
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders nothing (returns null)", () => {
    const { container } = render(<AuthTokenBridge />);
    expect(container.innerHTML).toBe("");
  });

  it("calls setAuthState with JWT when session exists", async () => {
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true, token: "test-jwt-token" });
    expect(mockGetConvexToken).toHaveBeenCalled();
  });

  it("calls setAuthState with authenticated=false when session is missing", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });

  it("does not set auth state while session is pending", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true });
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("updates setAuthState when session state changes", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false });
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });

    mockUseSession.mockReturnValue({ data: { id: "user-1" }, isPending: false });
    await act(async () => {
      result!.rerender(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: true, token: "test-jwt-token" });
  });

  it("clears auth state on unmount", async () => {
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
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("does not call setAuthState when setAuthState method is missing", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("sets authenticated=false when JWT fetch returns null", async () => {
    mockGetConvexToken.mockResolvedValue(null);
    await act(async () => {
      render(<AuthTokenBridge />);
    });
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });
});
