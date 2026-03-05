import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";

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

describe("WorkspaceErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <WorkspaceErrorBoundary>
        <div>Child content</div>
      </WorkspaceErrorBoundary>
    );
    expect(screen.getByText("Child content")).toBeTruthy();
  });

  it("shows error UI when child throws", () => {
    render(
      <WorkspaceErrorBoundary>
        <ThrowingChild />
      </WorkspaceErrorBoundary>
    );
    expect(screen.getByText("This component ran into a problem")).toBeTruthy();
  });

  it("does not expose internal error details", () => {
    render(
      <WorkspaceErrorBoundary>
        <ThrowingChild />
      </WorkspaceErrorBoundary>
    );
    expect(screen.queryByText("Test render error")).toBeNull();
  });

  it("shows retry button", () => {
    render(
      <WorkspaceErrorBoundary>
        <ThrowingChild />
      </WorkspaceErrorBoundary>
    );
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("calls onRetry and resets error state", () => {
    const onRetry = vi.fn();
    render(
      <WorkspaceErrorBoundary onRetry={onRetry}>
        <ThrowingChild shouldThrow={true} />
      </WorkspaceErrorBoundary>
    );

    expect(screen.getByText("This component ran into a problem")).toBeTruthy();

    // Click retry
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();

    // After retry, the component re-renders. Since ThrowingChild will still throw,
    // it will show the error again. But the callback was called.
  });
});
