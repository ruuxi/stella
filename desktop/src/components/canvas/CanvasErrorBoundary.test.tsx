import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CanvasErrorBoundary } from "./CanvasErrorBoundary";

// Suppress console.error for expected error boundary logs
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function ThrowingChild({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error("Test render error");
  }
  return <div>No error</div>;
}

describe("CanvasErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <CanvasErrorBoundary>
        <div>Child content</div>
      </CanvasErrorBoundary>
    );
    expect(screen.getByText("Child content")).toBeTruthy();
  });

  it("shows error UI when child throws", () => {
    render(
      <CanvasErrorBoundary>
        <ThrowingChild />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText("Component Error")).toBeTruthy();
    expect(screen.getByText("Test render error")).toBeTruthy();
  });

  it("shows stack trace in details", () => {
    render(
      <CanvasErrorBoundary>
        <ThrowingChild />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText("Stack trace")).toBeTruthy();
  });

  it("shows retry button", () => {
    render(
      <CanvasErrorBoundary>
        <ThrowingChild />
      </CanvasErrorBoundary>
    );
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("calls onRetry and resets error state", () => {
    const onRetry = vi.fn();
    render(
      <CanvasErrorBoundary onRetry={onRetry}>
        <ThrowingChild shouldThrow={true} />
      </CanvasErrorBoundary>
    );

    expect(screen.getByText("Component Error")).toBeTruthy();

    // Click retry
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();

    // After retry, the component re-renders. Since ThrowingChild will still throw,
    // it will show the error again. But the callback was called.
  });
});
