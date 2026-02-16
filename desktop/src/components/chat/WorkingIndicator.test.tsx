import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkingIndicator } from "./WorkingIndicator";

describe("WorkingIndicator", () => {
  it("shows explicit status when provided", () => {
    render(<WorkingIndicator status="Custom status text" />);
    expect(screen.getByText("Custom status text")).toBeTruthy();
  });

  it("shows task agent label and description", () => {
    const tasks = [
      { id: "task-1", agentType: "general", status: "running" as const, description: "Processing data" },
    ];
    render(<WorkingIndicator tasks={tasks} />);
    expect(screen.getByText(/Working/)).toBeTruthy();
    expect(screen.getByText(/Processing data/)).toBeTruthy();
  });

  it("maps agent types to labels", () => {
    const agentTypes = [
      { type: "general", label: "Working" },
      { type: "explore", label: "Exploring" },
      { type: "browser", label: "Browsing" },
      { type: "self_mod", label: "Modifying" },
      { type: "orchestrator", label: "Coordinating" },
    ];

    for (const { type, label } of agentTypes) {
      const tasks = [{ id: "t1", agentType: type, status: "running" as const, description: "" }];
      const { unmount } = render(<WorkingIndicator tasks={tasks} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("falls back to computeStatus for toolName", () => {
    render(<WorkingIndicator toolName="read" />);
    expect(screen.getByText("Gathering context")).toBeTruthy();
  });

  it("shows Thinking for isReasoning", () => {
    render(<WorkingIndicator isReasoning />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  it("shows Responding for isResponding", () => {
    render(<WorkingIndicator isResponding />);
    expect(screen.getByText("Responding")).toBeTruthy();
  });

  it("shows duration when provided", () => {
    render(<WorkingIndicator status="Working" duration="3s" />);
    expect(screen.getByText("3s")).toBeTruthy();
  });

  it("does not show duration when not provided", () => {
    render(<WorkingIndicator status="Working" />);
    expect(screen.queryByText(/\d+s/)).toBeNull();
  });

  it("shows default message when no props given", () => {
    render(<WorkingIndicator />);
    expect(screen.getByText("Considering next steps")).toBeTruthy();
  });

  it("prioritizes status over tasks and toolName", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Analyzing" },
    ];
    render(<WorkingIndicator status="Override" tasks={tasks} toolName="bash" />);
    expect(screen.getByText("Override")).toBeTruthy();
  });

  it("uses unknown agent type as-is for label", () => {
    const tasks = [
      { id: "t1", agentType: "custom_agent", status: "running" as const, description: "" },
    ];
    render(<WorkingIndicator tasks={tasks} />);
    expect(screen.getByText("custom_agent")).toBeTruthy();
  });

  it("shows task label without description when description is empty", () => {
    const tasks = [
      { id: "t1", agentType: "explore", status: "running" as const, description: "" },
    ];
    render(<WorkingIndicator tasks={tasks} />);
    // Should just show "Exploring" without the middle dot separator
    const statusEl = document.querySelector(".working-status");
    expect(statusEl?.textContent).toBe("Exploring");
  });

  it("shows task label with middle dot and description", () => {
    const tasks = [
      { id: "t1", agentType: "browser", status: "running" as const, description: "Loading page" },
    ];
    render(<WorkingIndicator tasks={tasks} />);
    const statusEl = document.querySelector(".working-status");
    // \u00b7 is the middle dot
    expect(statusEl?.textContent).toContain("Browsing");
    expect(statusEl?.textContent).toContain("Loading page");
  });

  it("prioritizes tasks over toolName when both provided", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Processing" },
    ];
    render(<WorkingIndicator tasks={tasks} toolName="bash" />);
    expect(screen.getByText(/Working/)).toBeTruthy();
    expect(screen.queryByText("Running commands")).toBeNull();
  });

  it("falls back to computeStatus when tasks is empty array", () => {
    render(<WorkingIndicator tasks={[]} toolName="grep" />);
    expect(screen.getByText("Searching the codebase")).toBeTruthy();
  });

  it("applies custom className", () => {
    const { container } = render(<WorkingIndicator status="Test" className="extra-class" />);
    const indicator = container.querySelector(".working-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator!.classList.contains("extra-class")).toBe(true);
  });

  it("renders a spinner", () => {
    const { container } = render(<WorkingIndicator status="Working" />);
    const spinner = container.querySelector("[data-component='spinner']");
    expect(spinner).toBeTruthy();
  });

  it("renders duration with separator element", () => {
    const { container } = render(<WorkingIndicator status="Working" duration="12s" />);
    const separator = container.querySelector(".working-separator");
    const durationEl = container.querySelector(".working-duration");
    expect(separator).toBeTruthy();
    expect(durationEl?.textContent).toBe("12s");
  });

  it("uses first task only when multiple tasks provided", () => {
    const tasks = [
      { id: "t1", agentType: "explore", status: "running" as const, description: "First task" },
      { id: "t2", agentType: "browser", status: "running" as const, description: "Second task" },
    ];
    render(<WorkingIndicator tasks={tasks} />);
    const statusEl = document.querySelector(".working-status");
    expect(statusEl?.textContent).toContain("Exploring");
    expect(statusEl?.textContent).toContain("First task");
  });
});
