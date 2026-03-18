import { describe, expect, it, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RegionCapture } from "../../../../src/shell/overlay/RegionCapture";

describe("RegionCapture", () => {
  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders the capture overlay", () => {
    const { container } = render(<RegionCapture />);
    expect(container.querySelector(".region-capture-root")).toBeTruthy();
  });

  it("shows dim overlay initially (no selection)", () => {
    const { container } = render(<RegionCapture />);
    expect(container.querySelector(".region-capture-dim")).toBeTruthy();
  });

  it("shows hint text", () => {
    const { container } = render(<RegionCapture />);
    expect(container.querySelector(".region-capture-hint")).toBeTruthy();
  });

  it("creates selection rectangle on mousedown + mousemove", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    const selection = container.querySelector(".region-capture-selection");
    expect(selection).toBeTruthy();
  });

  it("hides dim overlay when selection exists", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    expect(container.querySelector(".region-capture-dim")).toBeNull();
  });

  it("ignores non-left mouse button", () => {
    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });

    expect(container.querySelector(".region-capture-selection")).toBeNull();
  });

  it("submits click for small selection (< 6px)", () => {
    const submitRegionClick = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { capture: { submitRegionClick } };

    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    // Click with minimal movement
    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(root, { clientX: 102, clientY: 102 });

    expect(submitRegionClick).toHaveBeenCalled();
  });

  it("submits region selection for large drag (>= 6px)", () => {
    const submitRegionSelection = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { capture: { submitRegionSelection } };

    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.mouseDown(root, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(root, { clientX: 200, clientY: 200 });

    expect(submitRegionSelection).toHaveBeenCalled();
  });

  it("cancels on Escape key", () => {
    const cancelRegion = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { capture: { cancelRegion } };

    render(<RegionCapture />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelRegion).toHaveBeenCalled();
  });

  it("cancels on right-click (context menu)", () => {
    const cancelRegion = vi.fn();
    ((window as unknown as Record<string, unknown>)).electronAPI = { capture: { cancelRegion } };

    const { container } = render(<RegionCapture />);
    const root = container.querySelector(".region-capture-root")!;

    fireEvent.contextMenu(root);
    expect(cancelRegion).toHaveBeenCalled();
  });
});

