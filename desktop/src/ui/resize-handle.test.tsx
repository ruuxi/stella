import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ResizeHandle } from "./resize-handle";

describe("ResizeHandle", () => {
  it("renders with horizontal orientation by default", () => {
    const { container } = render(<ResizeHandle />);
    expect(container.querySelector("[data-orientation='horizontal']")).toBeTruthy();
  });

  it("renders with vertical orientation", () => {
    const { container } = render(<ResizeHandle orientation="vertical" />);
    expect(container.querySelector("[data-orientation='vertical']")).toBeTruthy();
  });

  it("fires onResize with delta during drag", () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const handle = container.querySelector("[data-component='resize-handle']")!;

    // Start drag
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 200 });

    // Move mouse
    fireEvent.mouseMove(document, { clientX: 150, clientY: 200 });
    expect(onResize).toHaveBeenCalledWith(50);

    // Release
    fireEvent.mouseUp(document);
  });

  it("fires onResize with Y delta for vertical orientation", () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizeHandle orientation="vertical" onResize={onResize} />
    );
    const handle = container.querySelector("[data-component='resize-handle']")!;

    fireEvent.mouseDown(handle, { clientX: 100, clientY: 200 });
    fireEvent.mouseMove(document, { clientX: 100, clientY: 250 });
    expect(onResize).toHaveBeenCalledWith(50);

    fireEvent.mouseUp(document);
  });

  it("does not fire onResize after mouseUp", () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const handle = container.querySelector("[data-component='resize-handle']")!;

    fireEvent.mouseDown(handle, { clientX: 100, clientY: 200 });
    fireEvent.mouseUp(document);

    onResize.mockClear();
    fireEvent.mouseMove(document, { clientX: 200, clientY: 200 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
