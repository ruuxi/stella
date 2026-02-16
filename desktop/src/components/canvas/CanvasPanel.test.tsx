import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { CanvasPanel } from "./CanvasPanel";

// Mock canvas state
const mockCloseCanvas = vi.fn();
const mockSetWidth = vi.fn();
let mockCanvasState = {
  isOpen: false,
  canvas: null as { name: string; title?: string; url?: string } | null,
  width: 560,
};

vi.mock("@/app/state/canvas-state", () => ({
  useCanvas: () => ({
    state: mockCanvasState,
    closeCanvas: mockCloseCanvas,
    setWidth: mockSetWidth,
  }),
}));

// Mock the lazy-loaded renderers
vi.mock("./renderers/panel", () => ({
  default: ({ canvas }: { canvas: { name: string } }) => (
    <div data-testid="panel-renderer">Panel: {canvas.name}</div>
  ),
}));

vi.mock("./renderers/appframe", () => ({
  default: ({ canvas }: { canvas: { name: string; url?: string } }) => (
    <div data-testid="appframe-renderer">Appframe: {canvas.url}</div>
  ),
}));

// Mock spinner
vi.mock("@/components/spinner", () => ({
  Spinner: ({ size }: { size: string }) => (
    <div data-testid="spinner" data-size={size} />
  ),
}));

describe("CanvasPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCanvasState = {
      isOpen: false,
      canvas: null,
      width: 560,
    };
    mockCloseCanvas.mockClear();
    mockSetWidth.mockClear();
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when not open and no canvas", () => {
    const { container } = render(<CanvasPanel />);
    expect(container.innerHTML).toBe("");
  });

  it("renders PanelRenderer when open with canvas (no URL)", async () => {
    // Use real timers so lazy() promises resolve
    vi.useRealTimers();

    mockCanvasState = {
      isOpen: true,
      canvas: { name: "my-chart", title: "My Chart" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    // Wait for rAF + lazy resolve
    await waitFor(() => {
      expect(screen.getByText("Panel: my-chart")).toBeTruthy();
    });

    expect(container.querySelector(".canvas-panel-shell")).toBeTruthy();

    // Restore fake timers for remaining tests
    vi.useFakeTimers();
  });

  it("renders AppframeRenderer when canvas has URL", async () => {
    vi.useRealTimers();

    mockCanvasState = {
      isOpen: true,
      canvas: {
        name: "my-app",
        title: "My App",
        url: "http://localhost:5180",
      },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("Appframe: http://localhost:5180")
      ).toBeTruthy();
    });

    expect(container.querySelector(".canvas-panel-shell")).toBeTruthy();

    vi.useFakeTimers();
  });

  it("sets canvas-panel-width CSS custom property", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 700,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const shell = container.querySelector(
      ".canvas-panel-shell"
    ) as HTMLElement;
    expect(shell.style.getPropertyValue("--canvas-panel-width")).toBe(
      "700px"
    );
  });

  it("renders close button with aria-label", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test", title: "Test Panel" },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const closeButton = screen.getByLabelText("Close canvas");
    expect(closeButton).toBeTruthy();
  });

  it("close button has title matching canvas title", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test", title: "My Panel Title" },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const closeButton = screen.getByLabelText("Close canvas");
    expect(closeButton.getAttribute("title")).toBe("My Panel Title");
  });

  it("close button falls back to canvas name when no title", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test-panel" },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const closeButton = screen.getByLabelText("Close canvas");
    expect(closeButton.getAttribute("title")).toBe("test-panel");
  });

  it("calls closeCanvas when close button is clicked", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    fireEvent.click(screen.getByLabelText("Close canvas"));
    expect(mockCloseCanvas).toHaveBeenCalled();
  });

  it("kills port process on close when canvas has localhost URL", () => {
    const shellKillByPort = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { shellKillByPort };

    mockCanvasState = {
      isOpen: true,
      canvas: {
        name: "my-app",
        url: "http://localhost:5180",
      },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    fireEvent.click(screen.getByLabelText("Close canvas"));
    expect(shellKillByPort).toHaveBeenCalledWith(5180);
    expect(mockCloseCanvas).toHaveBeenCalled();
  });

  it("does not kill port when URL is not localhost", () => {
    const shellKillByPort = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { shellKillByPort };

    mockCanvasState = {
      isOpen: true,
      canvas: {
        name: "my-app",
        url: "https://example.com",
      },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    fireEvent.click(screen.getByLabelText("Close canvas"));
    expect(shellKillByPort).not.toHaveBeenCalled();
    expect(mockCloseCanvas).toHaveBeenCalled();
  });

  it("applies canvas-open class after animation frame", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const shell = container.querySelector(".canvas-panel-shell");
    expect(shell?.className).toContain("canvas-open");
  });

  it("applies canvas-closing class during close animation", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container, rerender } = render(<CanvasPanel />);

    // Open animation
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Now close
    mockCanvasState = {
      isOpen: false,
      canvas: null,
      width: 560,
    };
    rerender(<CanvasPanel />);

    // During close animation, should have canvas-closing class
    const shell = container.querySelector(".canvas-panel-shell");
    expect(shell?.className).toContain("canvas-closing");
  });

  it("unmounts after close animation completes", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container, rerender } = render(<CanvasPanel />);

    // Open animation
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Close
    mockCanvasState = {
      isOpen: false,
      canvas: null,
      width: 560,
    };
    rerender(<CanvasPanel />);

    // Advance past ANIM_DURATION (350ms)
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Should be unmounted now
    expect(container.querySelector(".canvas-panel-shell")).toBeNull();
  });

  it("renders resize handle", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(container.querySelector(".canvas-resize-handle")).toBeTruthy();
    expect(container.querySelector(".canvas-resize-bar")).toBeTruthy();
  });

  it("handles resize mousedown - sets resizing class", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const handle = container.querySelector(
      ".canvas-resize-handle"
    ) as HTMLElement;
    fireEvent.mouseDown(handle, { button: 0, clientX: 500 });

    const shell = container.querySelector(".canvas-panel-shell");
    expect(shell?.className).toContain("canvas-resizing");
  });

  it("ignores non-left-button mousedown on resize handle", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const handle = container.querySelector(
      ".canvas-resize-handle"
    ) as HTMLElement;
    fireEvent.mouseDown(handle, { button: 2, clientX: 500 });

    const shell = container.querySelector(".canvas-panel-shell");
    expect(shell?.className).not.toContain("canvas-resizing");
  });

  it("calls setWidth during resize mousemove", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const handle = container.querySelector(
      ".canvas-resize-handle"
    ) as HTMLElement;
    fireEvent.mouseDown(handle, { button: 0, clientX: 500 });

    // Simulate drag to the left (increasing width since panel is on right)
    fireEvent.mouseMove(document, { clientX: 450 });

    // Width should be: startWidth - (newX - startX) = 560 - (450 - 500) = 560 + 50 = 610
    expect(mockSetWidth).toHaveBeenCalledWith(610);
  });

  it("cleans up resize on mouseup", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    const { container } = render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const handle = container.querySelector(
      ".canvas-resize-handle"
    ) as HTMLElement;
    fireEvent.mouseDown(handle, { button: 0, clientX: 500 });

    const shell = container.querySelector(".canvas-panel-shell");
    expect(shell?.className).toContain("canvas-resizing");

    fireEvent.mouseUp(document);

    expect(shell?.className).not.toContain("canvas-resizing");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("stops propagation of click on close button", () => {
    mockCanvasState = {
      isOpen: true,
      canvas: { name: "test" },
      width: 560,
    };

    render(<CanvasPanel />);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const closeButton = screen.getByLabelText("Close canvas");
    const clickEvent = new MouseEvent("click", { bubbles: true });
    const stopPropSpy = vi.spyOn(clickEvent, "stopPropagation");

    closeButton.dispatchEvent(clickEvent);
    expect(stopPropSpy).toHaveBeenCalled();
  });
});
