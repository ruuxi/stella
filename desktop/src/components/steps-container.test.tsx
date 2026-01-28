import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StepsContainer, type StepItem } from "./steps-container";

describe("StepsContainer", () => {
  const mockSteps: StepItem[] = [
    { id: "1", tool: "read", title: "config.ts", status: "completed" },
    { id: "2", tool: "grep", title: '"handleClick"', status: "completed" },
    { id: "3", tool: "write", title: "Button.tsx", status: "running" },
  ];

  it("renders nothing when steps array is empty", () => {
    const { container } = render(<StepsContainer steps={[]} />);
    // The component still renders the container but with no step items
    const stepItems = container.querySelectorAll('[data-slot="step-item"]');
    expect(stepItems).toHaveLength(0);
  });

  it("renders step items with correct tool labels", () => {
    render(<StepsContainer steps={mockSteps} />);

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
  });

  it("shows collapsed view by default (last 3 items)", () => {
    const manySteps: StepItem[] = [
      { id: "1", tool: "read", status: "completed" },
      { id: "2", tool: "grep", status: "completed" },
      { id: "3", tool: "write", status: "completed" },
      { id: "4", tool: "bash", status: "completed" },
      { id: "5", tool: "edit", status: "running" },
    ];

    render(<StepsContainer steps={manySteps} />);

    // Should only show last 3 in collapsed mode
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    expect(screen.queryByText("Search")).not.toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("shows all items when expanded", () => {
    const manySteps: StepItem[] = [
      { id: "1", tool: "read", status: "completed" },
      { id: "2", tool: "grep", status: "completed" },
      { id: "3", tool: "write", status: "completed" },
      { id: "4", tool: "bash", status: "completed" },
      { id: "5", tool: "edit", status: "running" },
    ];

    render(<StepsContainer steps={manySteps} expanded={true} />);

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("calls onToggle when footer is clicked", () => {
    const onToggle = vi.fn();
    render(<StepsContainer steps={mockSteps} onToggle={onToggle} />);

    const footer = screen.getByText(/Steps/);
    fireEvent.click(footer);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows spinner for running steps", () => {
    const { container } = render(<StepsContainer steps={mockSteps} />);

    // Running step should have a spinner
    const spinners = container.querySelectorAll('[data-component="spinner"]');
    expect(spinners.length).toBeGreaterThan(0);
  });

  it("shows checkmark for completed steps", () => {
    render(<StepsContainer steps={mockSteps} expanded={true} />);

    // Should have checkmarks for completed steps
    const checks = screen.getAllByText("✓");
    expect(checks).toHaveLength(2); // Two completed steps
  });

  it("shows X for error steps", () => {
    const errorSteps: StepItem[] = [
      { id: "1", tool: "bash", title: "invalid-cmd", status: "error" },
    ];

    render(<StepsContainer steps={errorSteps} />);

    expect(screen.getByText("✗")).toBeInTheDocument();
  });

  it("displays titles when expanded", () => {
    render(<StepsContainer steps={mockSteps} expanded={true} />);

    expect(screen.getByText("config.ts")).toBeInTheDocument();
    expect(screen.getByText('"handleClick"')).toBeInTheDocument();
    expect(screen.getByText("Button.tsx")).toBeInTheDocument();
  });

  it("hides titles when collapsed", () => {
    render(<StepsContainer steps={mockSteps} expanded={false} />);

    // Titles should not be visible in collapsed mode
    expect(screen.queryByText("config.ts")).not.toBeInTheDocument();
    expect(screen.queryByText('"handleClick"')).not.toBeInTheDocument();
    expect(screen.queryByText("Button.tsx")).not.toBeInTheDocument();
  });

  it("maps tool names to correct display labels", () => {
    const toolSteps: StepItem[] = [
      { id: "1", tool: "read", status: "completed" },
      { id: "2", tool: "write", status: "completed" },
      { id: "3", tool: "edit", status: "completed" },
      { id: "4", tool: "grep", status: "completed" },
      { id: "5", tool: "glob", status: "completed" },
      { id: "6", tool: "list", status: "completed" },
      { id: "7", tool: "bash", status: "completed" },
      { id: "8", tool: "webfetch", status: "completed" },
      { id: "9", tool: "task", status: "completed" },
      { id: "10", tool: "unknown_tool", status: "completed" },
    ];

    render(<StepsContainer steps={toolSteps} expanded={true} />);

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Find files")).toBeInTheDocument();
    expect(screen.getByText("List")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.getByText("Fetch")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("unknown_tool")).toBeInTheDocument();
  });

  it("sets data-expanded attribute based on prop", () => {
    const { container, rerender } = render(
      <StepsContainer steps={mockSteps} expanded={false} />
    );

    expect(
      container.querySelector('[data-component="steps-container"]')
    ).toHaveAttribute("data-expanded", "false");

    rerender(<StepsContainer steps={mockSteps} expanded={true} />);

    expect(
      container.querySelector('[data-component="steps-container"]')
    ).toHaveAttribute("data-expanded", "true");
  });
});
