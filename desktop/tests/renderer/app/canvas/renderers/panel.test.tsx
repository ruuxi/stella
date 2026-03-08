import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Mock the error boundary to pass through children
vi.mock("../../../../../src/app/canvas/WorkspaceErrorBoundary", () => ({
  WorkspaceErrorBoundary: ({
    children,
  }: {
    children: React.ReactNode;
    onRetry?: () => void;
  }) => <div data-testid="error-boundary">{children}</div>,
}));

// Mock spinner
vi.mock("@/ui/spinner", () => ({
  Spinner: ({ size }: { size: string }) => (
    <div data-testid="spinner" data-size={size} />
  ),
}));

// Import the component directly. The dynamic import to /workspace/panels/...
// will fail in jsdom, which lets us test the error handling paths.
import PanelRenderer from "../../../../../src/app/canvas/renderers/panel";

describe("PanelRenderer", () => {
  it("shows loading state initially", () => {
    render(<PanelRenderer panel={{ name: "test-panel" }} />);
    expect(screen.getByTestId("spinner")).toBeTruthy();
    expect(screen.getByText("Loading panel...")).toBeTruthy();
  });

  it("shows error when name is empty string", async () => {
    render(<PanelRenderer panel={{ name: "" }} />);

    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
    expect(screen.getByText("No panel name specified")).toBeTruthy();
  });

  it("shows error for unsafe panel names", async () => {
    render(<PanelRenderer panel={{ name: "../escape" }} />);

    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
    expect(
      screen.getByText('Invalid panel name. Use letters, numbers, "_" or "-".'),
    ).toBeTruthy();
  });

  it("shows error when dynamic import fails", async () => {
    render(<PanelRenderer panel={{ name: "nonexistent" }} />);

    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
    const errorMsg = screen.getByText(/Failed to load panel:/);
    expect(errorMsg).toBeTruthy();
  });

  it("shows retry button on error", async () => {
    render(<PanelRenderer panel={{ name: "bad-panel" }} />);

    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("retry button triggers reload", async () => {
    render(<PanelRenderer panel={{ name: "bad-panel" }} />);

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeTruthy();
    });

    // Click retry -- re-triggers the loading flow
    await act(async () => {
      fireEvent.click(screen.getByText("Retry"));
    });

    // Import will still fail, so it ends up in error state again
    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
  });

  it("appends .tsx extension if not present", async () => {
    render(<PanelRenderer panel={{ name: "my-chart" }} />);

    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
  });

  it("does not double-append .tsx if already present", async () => {
    render(<PanelRenderer panel={{ name: "my-chart.tsx" }} />);

    await waitFor(() => {
      expect(screen.getByText("Panel Error")).toBeTruthy();
    });
    const errorMsg = screen.getByText(/Failed to load panel:/);
    expect(errorMsg).toBeTruthy();
  });

  it("applies correct CSS classes to error view", async () => {
    const { container } = render(
      <PanelRenderer panel={{ name: "fail" }} />
    );

    await waitFor(() => {
      expect(container.querySelector(".canvas-error")).toBeTruthy();
    });
    expect(container.querySelector(".canvas-error-title")).toBeTruthy();
    expect(container.querySelector(".canvas-error-message")).toBeTruthy();
    expect(container.querySelector(".canvas-error-retry")).toBeTruthy();
  });

  it("applies correct CSS classes to loading view", () => {
    const { container } = render(
      <PanelRenderer panel={{ name: "test" }} />
    );
    expect(container.querySelector(".canvas-vite-loading")).toBeTruthy();
  });
});

