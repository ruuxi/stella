import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../../../../src/shell/sidebar/Sidebar";

const mockUseCurrentUser = vi.fn(() => ({
  user: null,
  hasConnectedAccount: false,
}));

vi.mock("@/global/auth/hooks/use-current-user", () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}));

vi.mock("@/global/auth/services/auth", () => ({
  secureSignOut: vi.fn(),
}));

vi.mock("../../../../src/global/settings/ThemePicker", () => ({
  ThemePicker: () => <div data-testid="theme-picker" />,
}));

describe("Sidebar", () => {
  it("renders sidebar with brand 'Stella'", () => {
    render(<Sidebar />);
    expect(screen.getByText("Stella")).toBeTruthy();
  });

  it("renders nav items: Connect", () => {
    render(<Sidebar />);
    expect(screen.getByText("Connect")).toBeTruthy();
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

  it("renders settings item", () => {
    render(<Sidebar />);
    expect(screen.getByText("Settings")).toBeTruthy();
  });
});



