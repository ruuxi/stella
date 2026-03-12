import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopConvexAuthProvider } from "../../../../src/global/auth/DesktopConvexAuthProvider";

const mockUseSession = vi.fn();
const mockGetConvexToken = vi.fn();
const mockAnonymousSignIn = vi.fn();
let capturedAuthState: {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args?: { forceRefreshToken?: boolean }) => Promise<string | null>;
} | null = null;

vi.mock("convex/react", () => ({
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: ReactNode;
    useAuth: () => typeof capturedAuthState;
  }) => {
    capturedAuthState = useAuth();
    return <div data-testid="convex-provider">{children}</div>;
  },
}));

vi.mock("@/global/auth/lib/auth-client", () => ({
  authClient: {
    useSession: () => mockUseSession(),
    signIn: {
      anonymous: () => mockAnonymousSignIn(),
    },
  },
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexToken: (options?: { forceRefresh?: boolean }) => mockGetConvexToken(options),
}));

vi.mock("@/infra/convex-client", () => ({
  convexClient: {},
}));

describe("DesktopConvexAuthProvider", () => {
  let mockSetAuthState: ReturnType<typeof vi.fn>;
  let mockSetCloudSyncEnabled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedAuthState = null;
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({ data: { id: "user-1" }, isPending: false });
    mockGetConvexToken.mockResolvedValue("jwt-token");
    mockAnonymousSignIn.mockResolvedValue(undefined);
    mockSetAuthState = vi.fn();
    mockSetCloudSyncEnabled = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      system: {
        setAuthState: mockSetAuthState,
        setCloudSyncEnabled: mockSetCloudSyncEnabled,
      },
      platform: "win32",
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders children through ConvexProviderWithAuth", () => {
    render(
      <DesktopConvexAuthProvider>
        <div data-testid="child" />
      </DesktopConvexAuthProvider>,
    );

    expect(screen.getByTestId("convex-provider")).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("reports authenticated state from the shared BetterAuth session", () => {
    render(
      <DesktopConvexAuthProvider>
        <div />
      </DesktopConvexAuthProvider>,
    );

    expect(capturedAuthState?.isLoading).toBe(false);
    expect(capturedAuthState?.isAuthenticated).toBe(true);
  });

  it("reports loading while the BetterAuth session is still pending", () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true });

    render(
      <DesktopConvexAuthProvider>
        <div />
      </DesktopConvexAuthProvider>,
    );

    expect(capturedAuthState?.isLoading).toBe(true);
    expect(capturedAuthState?.isAuthenticated).toBe(false);
  });

  it("reuses the shared token helper for Convex access tokens", async () => {
    render(
      <DesktopConvexAuthProvider>
        <div />
      </DesktopConvexAuthProvider>,
    );

    await expect(capturedAuthState?.fetchAccessToken()).resolves.toBe("jwt-token");
    expect(mockGetConvexToken.mock.calls).toContainEqual([{ forceRefresh: false }]);

    await expect(
      capturedAuthState?.fetchAccessToken({ forceRefreshToken: true }),
    ).resolves.toBe("jwt-token");
    expect(mockGetConvexToken.mock.calls).toContainEqual([{ forceRefresh: true }]);
  });

  it("disables cloud sync on mount and unmount", async () => {
    let result: ReturnType<typeof render>;

    await act(async () => {
      result = render(
        <DesktopConvexAuthProvider>
          <div />
        </DesktopConvexAuthProvider>,
      );
    });

    expect(mockSetCloudSyncEnabled).toHaveBeenCalledWith({ enabled: false });

    mockSetCloudSyncEnabled.mockClear();
    result!.unmount();
    expect(mockSetCloudSyncEnabled).toHaveBeenCalledWith({ enabled: false });
  });

  it("propagates authenticated host state when a session exists", async () => {
    await act(async () => {
      render(
        <DesktopConvexAuthProvider>
          <div />
        </DesktopConvexAuthProvider>,
      );
    });

    expect(mockGetConvexToken).toHaveBeenCalled();
    expect(mockSetAuthState).toHaveBeenCalledWith({
      authenticated: true,
      token: "jwt-token",
    });
    expect(mockAnonymousSignIn).not.toHaveBeenCalled();
  });

  it("starts anonymous auth when no session exists", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false });

    await act(async () => {
      render(
        <DesktopConvexAuthProvider>
          <div />
        </DesktopConvexAuthProvider>,
      );
    });

    expect(mockAnonymousSignIn).toHaveBeenCalledTimes(1);
    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });

  it("does not start anonymous auth while the session is pending", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true });

    await act(async () => {
      render(
        <DesktopConvexAuthProvider>
          <div />
        </DesktopConvexAuthProvider>,
      );
    });

    expect(mockAnonymousSignIn).not.toHaveBeenCalled();
    expect(mockSetAuthState).not.toHaveBeenCalled();
  });

  it("clears host auth state on unmount", async () => {
    let result: ReturnType<typeof render>;

    await act(async () => {
      result = render(
        <DesktopConvexAuthProvider>
          <div />
        </DesktopConvexAuthProvider>,
      );
    });

    mockSetAuthState.mockClear();
    result!.unmount();

    expect(mockSetAuthState).toHaveBeenCalledWith({ authenticated: false });
  });
});


