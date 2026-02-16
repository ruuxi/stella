import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { CanvasProvider, useCanvas } from "@/app/state/canvas-state";
import { TitleBar } from "./TitleBar";
import { useEffect } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <CanvasProvider>{children}</CanvasProvider>
);

// Helper that opens a canvas before rendering TitleBar
function CanvasOpener({ name, title }: { name: string; title?: string }) {
  const { openCanvas } = useCanvas();
  useEffect(() => {
    openCanvas({ name, title });
  }, [name, title, openCanvas]);
  return null;
}

function TitleBarWithCanvas({ name, title }: { name: string; title?: string }) {
  return (
    <CanvasProvider>
      <CanvasOpener name={name} title={title} />
      <TitleBar />
    </CanvasProvider>
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
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBar />, { wrapper });

    expect(screen.getByLabelText("Minimize")).toBeTruthy();
    expect(screen.getByLabelText("Maximize")).toBeTruthy();
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  it("renders mac-style title bar on darwin", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    const { container } = render(<TitleBar />, { wrapper });

    // Mac should not show custom window controls
    expect(screen.queryByLabelText("Minimize")).toBeNull();
    expect(container.querySelector(".title-bar-mac")).toBeTruthy();
  });

  it("calls minimize on button click", () => {
    const minimizeWindow = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      minimizeWindow,
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBar />, { wrapper });
    fireEvent.click(screen.getByLabelText("Minimize"));
    expect(minimizeWindow).toHaveBeenCalled();
  });

  it("calls maximize on button click", () => {
    const maximizeWindow = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      maximizeWindow,
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBar />, { wrapper });
    fireEvent.click(screen.getByLabelText("Maximize"));
    expect(maximizeWindow).toHaveBeenCalled();
  });

  it("calls close on button click", () => {
    const closeWindow = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      closeWindow,
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBar />, { wrapper });
    fireEvent.click(screen.getByLabelText("Close"));
    expect(closeWindow).toHaveBeenCalled();
  });

  it("renders without electronAPI", () => {
    // No electronAPI = unknown platform, should still render controls
    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar")).toBeTruthy();
  });

  it("shows Restore label when maximized", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      isMaximized: vi.fn().mockResolvedValue(true),
      maximizeWindow: vi.fn(),
    };

    await act(async () => {
      render(<TitleBar />, { wrapper });
    });

    expect(screen.getByLabelText("Restore")).toBeTruthy();
  });

  it("shows canvas title when canvas is open (win32)", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBarWithCanvas name="my-panel" title="My Panel" />);
    expect(screen.getByText("My Panel")).toBeTruthy();
  });

  it("shows canvas name as fallback when title is not set (win32)", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBarWithCanvas name="chart-view" />);
    expect(screen.getByText("chart-view")).toBeTruthy();
  });

  it("shows canvas title on mac", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBarWithCanvas name="panel" title="Mac Panel" />);
    expect(screen.getByText("Mac Panel")).toBeTruthy();
  });

  it("does not show canvas label when canvas is not open", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-canvas-label")).toBeNull();
  });

  it("has a drag region on both platforms", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-drag-region")).toBeTruthy();
  });

  it("has title-bar-close class on close button", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBar />, { wrapper });
    const closeBtn = screen.getByLabelText("Close");
    expect(closeBtn.classList.contains("title-bar-close")).toBe(true);
  });

  it("renders linux layout same as windows", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "linux",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    render(<TitleBar />, { wrapper });
    expect(screen.getByLabelText("Minimize")).toBeTruthy();
    expect(screen.getByLabelText("Maximize")).toBeTruthy();
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  it("toggles maximize/restore state after clicking maximize", async () => {
    const maximizeWindow = vi.fn();
    // First call: initial useEffect check. Second call: after maximize button click (setTimeout 50ms).
    const isMaximizedMock = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "win32",
      maximizeWindow,
      isMaximized: isMaximizedMock,
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
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-controls")).toBeNull();
  });

  it("renders drag region on mac", () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {
      platform: "darwin",
      isMaximized: vi.fn().mockResolvedValue(false),
    };

    const { container } = render(<TitleBar />, { wrapper });
    expect(container.querySelector(".title-bar-drag-region")).toBeTruthy();
  });
});
