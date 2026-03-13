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

vi.mock("../../../../src/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, onSelect }: any) => (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        onSelect?.();
      }}
    >
      {children}
    </button>
  ),
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

  it("renders app nav items: Home and Chat", () => {
    render(<Sidebar />);
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("New App")).toBeTruthy();
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
    fireEvent.click(screen.getByTitle("Settings"));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("calls onHome when clicking brand", () => {
    const onHome = vi.fn();
    render(<Sidebar onHome={onHome} />);
    fireEvent.click(screen.getByText("Stella"));
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it("calls onChat when clicking Chat", () => {
    const onChat = vi.fn();
    render(<Sidebar onChat={onChat} />);
    fireEvent.click(screen.getByText("Chat"));
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("calls Ask Stella from the New App menu", () => {
    const onNewAppAskStella = vi.fn();
    render(<Sidebar onNewAppAskStella={onNewAppAskStella} />);
    fireEvent.click(screen.getByText("Ask Stella"));
    expect(onNewAppAskStella).toHaveBeenCalledTimes(1);
  });

  it("calls Local Project from the New App menu", () => {
    const onNewAppLocalProject = vi.fn();
    render(<Sidebar onNewAppLocalProject={onNewAppLocalProject} />);
    fireEvent.click(screen.getByText("Local Project"));
    expect(onNewAppLocalProject).toHaveBeenCalledTimes(1);
  });

  it("shows 'Sign in' when unauthenticated", () => {
    render(<Sidebar />);
    expect(screen.getByText("Sign in")).toBeTruthy();
  });

  it("renders settings item", () => {
    render(<Sidebar />);
    expect(screen.getByTitle("Settings")).toBeTruthy();
  });

  it("renders local project items", () => {
    render(
      <Sidebar
        projects={[
          {
            id: "project-1",
            name: "stella-site",
            path: "C:/Users/redacted/projects/stella-site",
            source: "manual",
            framework: "vite",
            packageManager: "pnpm",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            runtime: { status: "stopped" },
          },
        ]}
      />,
    );

    expect(screen.getByText("stella-site")).toBeTruthy();
  });
});



