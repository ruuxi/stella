import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WorkingIndicator } from "../../../../src/app/chat/WorkingIndicator";

/** Helper: TextShimmer wraps each char in a <span> and converts spaces to
 *  non-breaking spaces (\u00A0), so getByText won't match.
 *  Query .working-status textContent and normalize NBSP back to regular spaces. */
const getStatusText = (container: HTMLElement) =>
  (container.querySelector(".working-status")?.textContent ?? "").replace(/\u00A0/g, " ");

describe("WorkingIndicator", () => {
  it("shows explicit status when provided", () => {
    const { container } = render(<WorkingIndicator status="Custom status text" />);
    expect(getStatusText(container)).toBe("Custom status text");
  });

  it("shows task agent label and description", () => {
    const tasks = [
      { id: "task-1", agentType: "general", status: "running" as const, description: "Processing data" },
    ];
    const { container } = render(<WorkingIndicator tasks={tasks} />);
    expect(getStatusText(container)).toContain("Working");
    expect(getStatusText(container)).toContain("Processing data");
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
      const { container, unmount } = render(<WorkingIndicator tasks={tasks} />);
      expect(getStatusText(container)).toBe(label);
      unmount();
    }
  });

  it("falls back to computeStatus for toolName", () => {
    const { container } = render(<WorkingIndicator toolName="read" />);
    expect(getStatusText(container)).toBe("Gathering context");
  });

  it("shows Thinking for isReasoning", () => {
    const { container } = render(<WorkingIndicator isReasoning />);
    expect(getStatusText(container)).toBe("Thinking");
  });

  it("shows Responding for isResponding", () => {
    const { container } = render(<WorkingIndicator isResponding />);
    expect(getStatusText(container)).toBe("Responding");
  });

  it("shows duration when provided", () => {
    const { container } = render(<WorkingIndicator status="Working" duration="3s" />);
    const durationEl = container.querySelector(".working-duration");
    expect(durationEl?.textContent).toBe("3s");
  });

  it("does not show duration when not provided", () => {
    const { container } = render(<WorkingIndicator status="Working" />);
    const durationEl = container.querySelector(".working-duration");
    expect(durationEl).toBeNull();
  });

  it("shows default message when no props given", () => {
    const { container } = render(<WorkingIndicator />);
    expect(getStatusText(container)).toBe("Considering next steps");
  });

  it("prioritizes status over tasks and toolName", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Analyzing" },
    ];
    const { container } = render(<WorkingIndicator status="Override" tasks={tasks} toolName="bash" />);
    expect(getStatusText(container)).toBe("Override");
  });

  it("uses unknown agent type as-is for label", () => {
    const tasks = [
      { id: "t1", agentType: "custom_agent", status: "running" as const, description: "" },
    ];
    const { container } = render(<WorkingIndicator tasks={tasks} />);
    expect(getStatusText(container)).toBe("custom_agent");
  });

  it("shows task label without description when description is empty", () => {
    const tasks = [
      { id: "t1", agentType: "explore", status: "running" as const, description: "" },
    ];
    const { container } = render(<WorkingIndicator tasks={tasks} />);
    expect(getStatusText(container)).toBe("Exploring");
  });

  it("shows task label with middle dot and description", () => {
    const tasks = [
      { id: "t1", agentType: "browser", status: "running" as const, description: "Loading page" },
    ];
    const { container } = render(<WorkingIndicator tasks={tasks} />);
    expect(getStatusText(container)).toContain("Browsing");
    expect(getStatusText(container)).toContain("Loading page");
  });

  it("prioritizes tasks over toolName when both provided", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Processing" },
    ];
    const { container } = render(<WorkingIndicator tasks={tasks} toolName="bash" />);
    expect(getStatusText(container)).toContain("Working");
    expect(getStatusText(container)).not.toContain("Running commands");
  });

  it("falls back to computeStatus when tasks is empty array", () => {
    const { container } = render(<WorkingIndicator tasks={[]} toolName="grep" />);
    expect(getStatusText(container)).toBe("Searching the codebase");
  });

  it("applies custom className", () => {
    const { container } = render(<WorkingIndicator status="Test" className="extra-class" />);
    const indicator = container.querySelector(".working-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator!.classList.contains("extra-class")).toBe(true);
  });

  it("renders the Stella animation indicator", () => {
    const { container } = render(<WorkingIndicator status="Working" />);
    const stella = container.querySelector(".indicator-stella");
    expect(stella).toBeTruthy();
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
    const { container } = render(<WorkingIndicator tasks={tasks} />);
    expect(getStatusText(container)).toContain("Exploring");
    expect(getStatusText(container)).toContain("First task");
  });
});


