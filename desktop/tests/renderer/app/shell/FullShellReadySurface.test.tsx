import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetView = vi.fn();
const mockOpenPanel = vi.fn();
const mockClosePanel = vi.fn();
const mockUiState = {
  view: "home",
  conversationId: "conv-123",
};

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

vi.mock("@/shell/sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
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
  FullShellRuntime: ({ activeView, isOrbVisible }: { activeView: string; isOrbVisible: boolean }) => (
    <div
      data-testid="full-shell-runtime"
      data-active-view={activeView}
      data-orb-visible={String(isOrbVisible)}
    />
  ),
}));

const { FullShellReadySurface } = await import("@/shell/FullShellReadySurface");

describe("FullShellReadySurface", () => {
  beforeEach(() => {
    mockSetView.mockReset();
    mockOpenPanel.mockReset();
    mockClosePanel.mockReset();
    mockUiState.view = "home";
    mockUiState.conversationId = "conv-123";
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
});
