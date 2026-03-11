import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthStatus } from "../../../../src/app/auth/AuthStatus";

const mockUseAuthSessionState = vi.fn();
const mockUseQuery = vi.fn();
vi.mock("@/app/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => mockUseAuthSessionState(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock("@/convex/api", () => ({
  api: {
    auth: {
      getCurrentUser: "getCurrentUser",
    },
  },
}));

const mockSecureSignOut = vi.fn();
vi.mock("@/app/auth/services/auth", () => ({
  secureSignOut: () => mockSecureSignOut(),
}));

describe("AuthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureSignOut.mockResolvedValue(undefined);
    mockUseAuthSessionState.mockReturnValue({
      hasConnectedAccount: true,
    });
  });

  it("renders nothing when not authenticated", () => {
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: false });
    mockUseQuery.mockReturnValue(undefined);
    const { container } = render(<AuthStatus />);
    expect(container.innerHTML).toBe("");
  });

  it("renders 'Signed in' when authenticated but user data is loading", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<AuthStatus />);
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("renders 'Signed in' when authenticated but user data is null", () => {
    mockUseQuery.mockReturnValue(null);
    render(<AuthStatus />);
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("renders user name when available", () => {
    mockUseQuery.mockReturnValue({ name: "Alice", email: "alice@example.com" });
    render(<AuthStatus />);
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("renders email when name is not available", () => {
    mockUseQuery.mockReturnValue({ email: "bob@example.com" });
    render(<AuthStatus />);
    expect(screen.getByText("bob@example.com")).toBeTruthy();
  });

  it("renders 'Signed in' when user has no name or email", () => {
    mockUseQuery.mockReturnValue({});
    render(<AuthStatus />);
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("renders sign out button when authenticated", () => {
    mockUseQuery.mockReturnValue({ name: "Alice" });
    render(<AuthStatus />);
    expect(screen.getByText("Sign out")).toBeTruthy();
  });

  it("calls secureSignOut when sign out button is clicked", () => {
    mockUseQuery.mockReturnValue({ name: "Alice" });
    render(<AuthStatus />);
    fireEvent.click(screen.getByText("Sign out"));
    expect(mockSecureSignOut).toHaveBeenCalled();
  });

  it("skips user query when not authenticated", () => {
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: false });
    mockUseQuery.mockReturnValue(undefined);
    render(<AuthStatus />);
    expect(mockUseQuery).toHaveBeenCalledWith("getCurrentUser", "skip");
  });

  it("fetches user query when authenticated", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<AuthStatus />);
    expect(mockUseQuery).toHaveBeenCalledWith("getCurrentUser", {});
  });

  it("prefers name over email for display", () => {
    mockUseQuery.mockReturnValue({ name: "Charlie", email: "charlie@test.com" });
    render(<AuthStatus />);
    expect(screen.getByText("Charlie")).toBeTruthy();
    expect(screen.queryByText("charlie@test.com")).toBeNull();
  });

  it("renders nothing for anonymous sessions", () => {
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: false });
    mockUseQuery.mockReturnValue({ isAnonymous: true });

    const { container } = render(<AuthStatus />);

    expect(container.innerHTML).toBe("");
    expect(mockUseQuery).toHaveBeenCalledWith("getCurrentUser", "skip");
  });
});
