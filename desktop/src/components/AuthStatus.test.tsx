import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthStatus } from "./AuthStatus";

const mockUseConvexAuth = vi.fn();
const mockUseQuery = vi.fn();
vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
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
vi.mock("@/services/auth", () => ({
  secureSignOut: () => mockSecureSignOut(),
}));

describe("AuthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureSignOut.mockResolvedValue(undefined);
  });

  it("renders nothing when not authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    mockUseQuery.mockReturnValue(undefined);
    const { container } = render(<AuthStatus />);
    expect(container.innerHTML).toBe("");
  });

  it("renders 'Signed in' when authenticated but user data is loading", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue(undefined);
    render(<AuthStatus />);
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("renders 'Signed in' when authenticated but user data is null", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue(null);
    render(<AuthStatus />);
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("renders user name when available", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({ name: "Alice", email: "alice@example.com" });
    render(<AuthStatus />);
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("renders email when name is not available", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({ email: "bob@example.com" });
    render(<AuthStatus />);
    expect(screen.getByText("bob@example.com")).toBeTruthy();
  });

  it("renders 'Signed in' when user has no name or email", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({});
    render(<AuthStatus />);
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("renders sign out button when authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({ name: "Alice" });
    render(<AuthStatus />);
    expect(screen.getByText("Sign out")).toBeTruthy();
  });

  it("calls secureSignOut when sign out button is clicked", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({ name: "Alice" });
    render(<AuthStatus />);
    fireEvent.click(screen.getByText("Sign out"));
    expect(mockSecureSignOut).toHaveBeenCalled();
  });

  it("skips user query when not authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    mockUseQuery.mockReturnValue(undefined);
    render(<AuthStatus />);
    expect(mockUseQuery).toHaveBeenCalledWith("getCurrentUser", "skip");
  });

  it("fetches user query when authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue(undefined);
    render(<AuthStatus />);
    expect(mockUseQuery).toHaveBeenCalledWith("getCurrentUser", {});
  });

  it("prefers name over email for display", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({ name: "Charlie", email: "charlie@test.com" });
    render(<AuthStatus />);
    expect(screen.getByText("Charlie")).toBeTruthy();
    expect(screen.queryByText("charlie@test.com")).toBeNull();
  });
});
