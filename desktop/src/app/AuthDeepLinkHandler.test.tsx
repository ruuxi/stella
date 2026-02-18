import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthDeepLinkHandler } from "./AuthDeepLinkHandler";

const mockClientFetch = vi.fn();
const mockGetSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    $fetch: (...args: unknown[]) => mockClientFetch(...args),
    getSession: () => mockGetSession(),
  },
}));

describe("AuthDeepLinkHandler", () => {
  let authCallback: ((data: { url: string }) => Promise<void>) | null;
  let unsubscribeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    authCallback = null;
    unsubscribeSpy = vi.fn();
    mockClientFetch.mockResolvedValue({});
    mockGetSession.mockResolvedValue({});

    ((window as unknown as Record<string, unknown>)).electronAPI = {
      onAuthCallback: (cb: (data: { url: string }) => Promise<void>) => {
        authCallback = cb;
        return unsubscribeSpy;
      },
    };
  });

  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders nothing (returns null)", () => {
    const { container } = render(<AuthDeepLinkHandler />);
    expect(container.innerHTML).toBe("");
  });

  it("registers auth callback on mount", () => {
    render(<AuthDeepLinkHandler />);
    expect(authCallback).toBeTruthy();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<AuthDeepLinkHandler />);
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it("verifies one-time token from deep link URL", async () => {
    render(<AuthDeepLinkHandler />);

    await authCallback!({ url: "stella://auth?ott=test-token-123" });

    expect(mockClientFetch).toHaveBeenCalledWith("/cross-domain/one-time-token/verify", {
      method: "POST",
      body: { token: "test-token-123" },
    });
  });

  it("calls getSession after verifying token", async () => {
    render(<AuthDeepLinkHandler />);

    await authCallback!({ url: "stella://auth?ott=my-token" });

    expect(mockClientFetch).toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalled();
  });

  it("does nothing when URL has no ott parameter", async () => {
    render(<AuthDeepLinkHandler />);

    await authCallback!({ url: "stella://auth?other=value" });

    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it("rejects callbacks from non-auth host", async () => {
    render(<AuthDeepLinkHandler />);

    await authCallback!({ url: "stella://evil?ott=test-token-123" });

    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it("rejects callbacks with non-stella scheme", async () => {
    render(<AuthDeepLinkHandler />);

    await authCallback!({ url: "https://auth.example.com/?ott=test-token-123" });

    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it("handles verify errors gracefully without throwing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockClientFetch.mockRejectedValue(new Error("verify failed"));

    render(<AuthDeepLinkHandler />);
    await authCallback!({ url: "stella://auth?ott=bad-token" });

    expect(consoleSpy).toHaveBeenCalledWith("Failed to handle auth callback", expect.any(Error));
    consoleSpy.mockRestore();
  });

  it("does not register callback when electronAPI is absent", () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    render(<AuthDeepLinkHandler />);
    expect(authCallback).toBeNull();
  });

  it("does not register callback when onAuthCallback is missing", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};
    render(<AuthDeepLinkHandler />);
    expect(authCallback).toBeNull();
  });

  it("handles URL with both ott and other params", async () => {
    render(<AuthDeepLinkHandler />);

    await authCallback!({ url: "stella://auth?foo=bar&ott=token-xyz&baz=qux" });

    expect(mockClientFetch).toHaveBeenCalledWith("/cross-domain/one-time-token/verify", {
      method: "POST",
      body: { token: "token-xyz" },
    });
  });
});
