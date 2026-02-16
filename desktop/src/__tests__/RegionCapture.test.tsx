import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// --- Mocks ---

const mockCancelRegionCapture = vi.fn();
const mockSubmitRegionClick = vi.fn();
const mockSubmitRegionSelection = vi.fn();

const mockElectronApi = {
  cancelRegionCapture: mockCancelRegionCapture,
  submitRegionClick: mockSubmitRegionClick,
  submitRegionSelection: mockSubmitRegionSelection,
};

vi.mock("../services/electron", () => ({
  getElectronApi: () => mockElectronApi,
}));

import { RegionCapture } from "../screens/RegionCapture";

// --- Tests ---

describe("RegionCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the capture overlay", () => {
    render(<RegionCapture />);
    expect(screen.getByText(/Click to capture window/)).toBeInTheDocument();
  });

  it("renders the dim overlay initially (no selection)", () => {
    const { container } = render(<RegionCapture />);
    expect(container.querySelector(".region-capture-dim")).toBeInTheDocument();
    expect(container.querySelector(".region-capture-selection")).not.toBeInTheDocument();
  });

  it("shows selection rectangle on mouse drag", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    const selection = container.querySelector(".region-capture-selection");
    expect(selection).toBeInTheDocument();
    expect(selection).toHaveStyle({ left: "100px", top: "100px", width: "100px", height: "100px" });
  });

  it("hides dim overlay while selection is active", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(root, { clientX: 150, clientY: 150 });

    expect(container.querySelector(".region-capture-dim")).not.toBeInTheDocument();
    expect(container.querySelector(".region-capture-selection")).toBeInTheDocument();
  });

  it("ignores non-left mouse button on mouseDown", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    // Right-click (button 2) should not start selection
    fireEvent.mouseDown(root, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    expect(container.querySelector(".region-capture-selection")).not.toBeInTheDocument();
    expect(container.querySelector(".region-capture-dim")).toBeInTheDocument();
  });

  it("does not update currentPoint on mouseMove if no drag started", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    // Move without pressing
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    expect(container.querySelector(".region-capture-selection")).not.toBeInTheDocument();
  });

  it("calls submitRegionSelection on mouseUp with large enough area", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(root, { clientX: 200, clientY: 200 });

    expect(mockSubmitRegionSelection).toHaveBeenCalledWith({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });
  });

  it("calls submitRegionClick for small selection (below MIN_SELECTION_SIZE)", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 102, clientY: 102 });
    fireEvent.mouseUp(root, { clientX: 102, clientY: 102 });

    expect(mockSubmitRegionClick).toHaveBeenCalledWith({ x: 102, y: 102 });
    expect(mockSubmitRegionSelection).not.toHaveBeenCalled();
  });

  it("clears selection after mouseUp", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(root, { clientX: 200, clientY: 200 });

    // Selection should be cleared (dim overlay should be back)
    expect(container.querySelector(".region-capture-dim")).toBeInTheDocument();
    expect(container.querySelector(".region-capture-selection")).not.toBeInTheDocument();
  });

  it("cancels on Escape key", () => {
    render(<RegionCapture />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(mockCancelRegionCapture).toHaveBeenCalled();
  });

  it("cancels on right-click (context menu)", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.contextMenu(root);

    expect(mockCancelRegionCapture).toHaveBeenCalled();
  });

  it("clears selection on contextMenu during drag", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    // Ensure selection is visible
    expect(container.querySelector(".region-capture-selection")).toBeInTheDocument();

    fireEvent.contextMenu(root);

    expect(container.querySelector(".region-capture-dim")).toBeInTheDocument();
    expect(container.querySelector(".region-capture-selection")).not.toBeInTheDocument();
  });

  it("does not call submitRegionSelection on mouseUp without prior mouseDown", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseUp(root, { clientX: 200, clientY: 200 });

    expect(mockSubmitRegionSelection).not.toHaveBeenCalled();
    expect(mockSubmitRegionClick).not.toHaveBeenCalled();
  });

  it("handles selection where drag goes up-left (reversed coordinates)", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseMove(root, { clientX: 100, clientY: 100 });

    const selection = container.querySelector(".region-capture-selection");
    expect(selection).toBeInTheDocument();
    // Math.min should produce correct x/y
    expect(selection).toHaveStyle({ left: "100px", top: "100px", width: "100px", height: "100px" });
  });

  it("renders hint text", () => {
    render(<RegionCapture />);
    expect(
      screen.getByText("Click to capture window - drag to capture region - Right-click or Esc to cancel")
    ).toBeInTheDocument();
  });
});
