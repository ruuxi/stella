import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopConvexAuthProvider } from "../../../../src/app/auth/DesktopConvexAuthProvider";

const mockUseSession = vi.fn();
const mockGetConvexToken = vi.fn();
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

vi.mock("@/app/auth/lib/auth-client", () => ({
  authClient: {
    useSession: () => mockUseSession(),
  },
}));

vi.mock("@/app/auth/services/auth-token", () => ({
  getConvexToken: (options?: { forceRefresh?: boolean }) => mockGetConvexToken(options),
}));

vi.mock("@/infra/convex-client", () => ({
  convexClient: {},
}));

describe("DesktopConvexAuthProvider", () => {
  beforeEach(() => {
    capturedAuthState = null;
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({ data: { id: "user-1" }, isPending: false });
    mockGetConvexToken.mockResolvedValue("jwt-token");
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
    expect(mockGetConvexToken).toHaveBeenCalledWith({ forceRefresh: false });

    await expect(
      capturedAuthState?.fetchAccessToken({ forceRefreshToken: true }),
    ).resolves.toBe("jwt-token");
    expect(mockGetConvexToken).toHaveBeenLastCalledWith({ forceRefresh: true });
  });
});
