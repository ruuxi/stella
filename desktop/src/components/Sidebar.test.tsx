import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "convex/react";
import { Sidebar } from "./Sidebar";

vi.mock("convex/react", () => ({
  useConvexAuth: vi.fn(() => ({ isAuthenticated: false, isLoading: false })),
  useQuery: vi.fn(() => null),
}));

vi.mock("@/convex/api", () => ({
  api: { auth: { getCurrentUser: "auth:getCurrentUser" } },
}));

vi.mock("@/services/auth", () => ({
  secureSignOut: vi.fn(),
}));

vi.mock("./ThemePicker", () => ({
  ThemePicker: () => <div data-testid="theme-picker" />,
}));

describe("Sidebar", () => {
  it("renders sidebar with brand 'Stella'", () => {
    render(<Sidebar />);
    expect(screen.getByText("Stella")).toBeTruthy();
  });

  it("renders nav items: App Store, Connect, Social", () => {
    render(<Sidebar />);
    expect(screen.getByText("App Store")).toBeTruthy();
    expect(screen.getByText("Connect")).toBeTruthy();
    expect(screen.getByText("Social")).toBeTruthy();
  });

  it("calls onStore when clicking App Store", () => {
    const onStore = vi.fn();
    render(<Sidebar onStore={onStore} />);
    fireEvent.click(screen.getByText("App Store"));
    expect(onStore).toHaveBeenCalledTimes(1);
  });

  it("calls onConnect when clicking Connect", () => {
    const onConnect = vi.fn();
    render(<Sidebar onConnect={onConnect} />);
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("calls onSettings when clicking Settings", () => {
    const onSettings = vi.fn();
    render(<Sidebar onSettings={onSettings} />);
    fireEvent.click(screen.getByText("Settings"));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("calls onHome when clicking brand", () => {
    const onHome = vi.fn();
    render(<Sidebar onHome={onHome} />);
    fireEvent.click(screen.getByText("Stella"));
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it("shows 'Sign in' when unauthenticated", () => {
    render(<Sidebar />);
    expect(screen.getByText("Sign in")).toBeTruthy();
  });

  it("applies active class to App Store when storeActive is true", () => {
    render(<Sidebar storeActive />);
    const appStoreButton = screen.getByText("App Store").closest("button");
    expect(appStoreButton?.className).toContain("sidebar-nav-item--active");
  });
});
