import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorkspaceProvider, useWorkspace } from "@/context/workspace-state";
import { TitleBar } from "../../../../src/shell/TitleBar";
import { useEffect } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <WorkspaceProvider>{children}</WorkspaceProvider>
);

function PanelOpener({ name, title }: { name: string; title?: string }) {
  const { openPanel } = useWorkspace();
  useEffect(() => {
    openPanel({ name, title });
  }, [name, title, openPanel]);
  return null;
}

function TitleBarWithPanel({ name, title }: { name: string; title?: string }) {
  return (
    <WorkspaceProvider>
      <PanelOpener name={name} title={title} />
      <TitleBar />
    </WorkspaceProvider>
  );
}

describe("TitleBar", () => {
  beforeEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders window controls on non-mac platform", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBar />, { wrapper });

    expect(screen.getByLabelText("Minimize")).toBeTruthy();
    expect(screen.getByLabelText("Maximize")).toBeTruthy();
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  it("renders mac-style title bar on darwin", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    const { container } = render(<TitleBar />, { wrapper });

    // Mac should not show custom window controls
    expect(screen.queryByLabelText("Minimize")).toBeNull();
    expect(container.querySelector(".title-bar-mac")).toBeTruthy();
  });

  it("calls minimize on button click", () => {
    const minimize = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { minimize, isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBar />, { wrapper });
    fireEvent.click(screen.getByLabelText("Minimize"));
    expect(minimize).toHaveBeenCalled();
  });

  it("calls maximize on button click", () => {
    const maximize = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { maximize, isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBar />, { wrapper });
    fireEvent.click(screen.getByLabelText("Maximize"));
    expect(maximize).toHaveBeenCalled();
  });

  it("calls close on button click", () => {
    const close = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { close, isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBar />, { wrapper });
    fireEvent.click(screen.getByLabelText("Close"));
    expect(close).toHaveBeenCalled();
  });

  it("renders without electronAPI", () => {
    // No electronAPI = unknown platform, should still render controls
    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar")).toBeTruthy();
  });

  it("shows Restore label when maximized", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(true), maximize: vi.fn() },
    };

    await act(async () => {
      render(<TitleBar />, { wrapper });
    });

    expect(screen.getByLabelText("Restore")).toBeTruthy();
  });

  it("shows panel title when a workspace panel is open (win32)", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBarWithPanel name="my-panel" title="My Panel" />);
    expect(screen.getByText("My Panel")).toBeTruthy();
  });

  it("shows panel name as fallback when title is not set (win32)", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBarWithPanel name="chart-view" />);
    expect(screen.getByText("chart-view")).toBeTruthy();
  });

  it("shows panel title on mac", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBarWithPanel name="panel" title="Mac Panel" />);
    expect(screen.getByText("Mac Panel")).toBeTruthy();
  });

  it("does not show panel label when no workspace panel is open", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-workspace-label")).toBeNull();
  });

  it("has a drag region on both platforms", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-drag-region")).toBeTruthy();
  });

  it("has title-bar-close class on close button", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBar />, { wrapper });
    const closeBtn = screen.getByLabelText("Close");
    expect(closeBtn.classList.contains("title-bar-close")).toBe(true);
  });

  it("renders linux layout same as windows", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "linux",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    render(<TitleBar />, { wrapper });
    expect(screen.getByLabelText("Minimize")).toBeTruthy();
    expect(screen.getByLabelText("Maximize")).toBeTruthy();
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  it("toggles maximize/restore state after clicking maximize", async () => {
    const maximize = vi.fn();
    // First call: initial useEffect check. Second call: after maximize button click (setTimeout 50ms).
    const isMaximizedMock = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      window: { maximize, isMaximized: isMaximizedMock },
    };

    await act(async () => {
      render(<TitleBar />, { wrapper });
    });

    // Initially shows Maximize
    expect(screen.getByLabelText("Maximize")).toBeTruthy();

    // Click maximize
    fireEvent.click(screen.getByLabelText("Maximize"));

    // Wait for the internal 50ms setTimeout + isMaximized promise to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    expect(screen.getByLabelText("Restore")).toBeTruthy();
  });

  it("mac title bar does not render controls", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-controls")).toBeNull();
  });

  it("renders drag region on mac", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      window: { isMaximized: vi.fn().mockResolvedValue(false) },
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-drag-region")).toBeTruthy();
  });
});


