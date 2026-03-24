import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetView = vi.fn();
const mockOpenPanel = vi.fn();
const mockClosePanel = vi.fn();
const mockDispatchOpenOrbChat = vi.fn();
const mockDispatchCloseOrbChat = vi.fn();
const mockUiState = {
  view: "home",
  conversationId: "conv-123",
};
let fullShellRuntimeMounts = 0;
let fullShellRuntimeUnmounts = 0;

vi.mock("@/context/ui-state", () => ({
  useUiState: () => ({
    state: mockUiState,
    setView: mockSetView,
  }),
}));

vi.mock("@/context/workspace-state", () => ({
  useWorkspace: () => ({
    state: { activePanel: null },
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
  }),
}));

vi.mock("@/context/dev-projects-state", () => ({
  useDevProjects: () => ({
    projects: [],
    pickProjectDirectory: vi.fn(async () => null),
  }),
}));

vi.mock("@/global/auth/services/auth", () => ({
  secureSignOut: vi.fn(),
}));

vi.mock("@/shared/lib/stella-orb-chat", () => ({
  dispatchOpenOrbChat: mockDispatchOpenOrbChat,
  dispatchCloseOrbChat: mockDispatchCloseOrbChat,
}));

vi.mock("@/shell/sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("@/shell/context-menu/StellaContextMenu", () => ({
  StellaContextMenu: ({ children, onOpenOrbChat, onCloseOrbChat }: any) => (
    <div data-testid="stella-context-menu">
      <button
        data-testid="context-open-orb"
        onClick={() => onOpenOrbChat?.({ window: null, windowText: "Captured section" })}
      >
        Open orb
      </button>
      <button data-testid="context-close-chat" onClick={() => onCloseOrbChat?.()}>
        Close chat
      </button>
      {children}
    </div>
  ),
}));

vi.mock("@/app/workspace/WorkspaceArea", () => ({
  WorkspaceArea: ({ view }: { view: string }) => (
    <div data-testid="workspace-area" data-view={view} />
  ),
}));

vi.mock("@/shell/full-shell-dialogs", () => ({
  FullShellDialogs: () => null,
}));

vi.mock("@/shell/FullShellRuntime", () => ({
  FullShellRuntime: ({ activeView, isOrbVisible }: { activeView: string; isOrbVisible: boolean }) => {
    useEffect(() => {
      fullShellRuntimeMounts += 1;
      return () => {
        fullShellRuntimeUnmounts += 1;
      };
    }, []);

    return (
      <div
        data-testid="full-shell-runtime"
        data-active-view={activeView}
        data-orb-visible={String(isOrbVisible)}
      />
    );
  },
}));

const { FullShellReadySurface } = await import("@/shell/FullShellReadySurface");

describe("FullShellReadySurface", () => {
  beforeEach(() => {
    mockSetView.mockReset();
    mockOpenPanel.mockReset();
    mockClosePanel.mockReset();
    mockDispatchOpenOrbChat.mockReset();
    mockDispatchCloseOrbChat.mockReset();
    mockUiState.view = "home";
    mockUiState.conversationId = "conv-123";
    fullShellRuntimeMounts = 0;
    fullShellRuntimeUnmounts = 0;
  });

  it("mounts runtime behavior on normal home entry", async () => {
    render(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    expect(await screen.findByTestId("full-shell-runtime")).toHaveAttribute(
      "data-active-view",
      "home",
    );
    expect(screen.getByTestId("workspace-area")).toHaveAttribute(
      "data-view",
      "home",
    );
  });

  it("mounts runtime behavior for direct chat entry without requiring a New App click", async () => {
    mockUiState.view = "chat";

    render(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    expect(await screen.findByTestId("full-shell-runtime")).toHaveAttribute(
      "data-active-view",
      "chat",
    );
    expect(screen.queryByTestId("workspace-area")).toBeNull();
  });

  it("opens the floating orb from the context menu and seeds captured context", async () => {
    render(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    fireEvent.click(screen.getByTestId("context-open-orb"));

    expect(mockDispatchOpenOrbChat).toHaveBeenCalledWith({
      chatContext: { window: null, windowText: "Captured section" },
    });
    expect(mockSetView).not.toHaveBeenCalled();
  });

  it("leaves chat view before opening the floating orb from the context menu", async () => {
    mockUiState.view = "chat";

    render(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    fireEvent.click(screen.getByTestId("context-open-orb"));

    expect(mockSetView).toHaveBeenCalledWith("home");
    expect(mockDispatchOpenOrbChat).toHaveBeenCalledWith({
      chatContext: { window: null, windowText: "Captured section" },
    });
  });

  it("context menu close closes the floating orb chat", async () => {
    mockUiState.view = "chat";

    render(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    fireEvent.click(screen.getByTestId("context-close-chat"));

    expect(mockDispatchCloseOrbChat).toHaveBeenCalledTimes(1);
    expect(mockClosePanel).not.toHaveBeenCalled();
    expect(mockSetView).not.toHaveBeenCalled();
    expect(mockDispatchOpenOrbChat).not.toHaveBeenCalled();
  });

  it("keeps the runtime mounted while switching between desktop pages", async () => {
    const { rerender } = render(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    expect(await screen.findByTestId("full-shell-runtime")).toHaveAttribute(
      "data-active-view",
      "home",
    );
    expect(fullShellRuntimeMounts).toBe(1);
    expect(fullShellRuntimeUnmounts).toBe(0);

    mockUiState.view = "chat";
    rerender(
      <FullShellReadySurface
        dashboardState={null}
        onboardingExiting={false}
      />,
    );

    expect(await screen.findByTestId("full-shell-runtime")).toHaveAttribute(
      "data-active-view",
      "chat",
    );
    expect(fullShellRuntimeMounts).toBe(1);
    expect(fullShellRuntimeUnmounts).toBe(0);
  });
});
