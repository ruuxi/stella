import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskIndicator } from "./TaskIndicator";

describe("TaskIndicator", () => {
  it("renders nothing when no tasks", () => {
    const { container } = render(<TaskIndicator tasks={[]} />);
    expect(container.querySelector(".task-indicator")).toBeNull();
  });

  it("renders nothing when no running tasks", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "completed" as const, description: "Done" },
    ];
    const { container } = render(<TaskIndicator tasks={tasks} />);
    expect(container.querySelector(".task-indicator")).toBeNull();
  });

  it("renders running tasks", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Processing" },
      { id: "t2", agentType: "explore", status: "running" as const, description: "Searching" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Processing")).toBeTruthy();
    expect(screen.getByText("Exploring")).toBeTruthy();
    expect(screen.getByText("Searching")).toBeTruthy();
  });

  it("filters out non-running tasks", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Active" },
      { id: "t2", agentType: "explore", status: "completed" as const, description: "Finished" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("uses statusText over description when available", () => {
    const tasks = [
      {
        id: "t1",
        agentType: "browser",
        status: "running" as const,
        description: "Default desc",
        statusText: "Navigating to page",
      },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Navigating to page")).toBeTruthy();
    expect(screen.queryByText("Default desc")).toBeNull();
  });

  it("maps agent types correctly", () => {
    const tasks = [
      { id: "t1", agentType: "self_mod", status: "running" as const, description: "Updating" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Modifying")).toBeTruthy();
  });

  it("maps orchestrator agent type to Coordinating", () => {
    const tasks = [
      { id: "t1", agentType: "orchestrator", status: "running" as const, description: "Planning" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Coordinating")).toBeTruthy();
  });

  it("maps browser agent type to Browsing", () => {
    const tasks = [
      { id: "t1", agentType: "browser", status: "running" as const, description: "Loading page" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Browsing")).toBeTruthy();
  });

  it("uses unknown agent type as-is for label", () => {
    const tasks = [
      { id: "t1", agentType: "my_custom_agent", status: "running" as const, description: "Doing stuff" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("my_custom_agent")).toBeTruthy();
  });

  it("renders nothing when all tasks have error status", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "error" as const, description: "Failed" },
    ];
    const { container } = render(<TaskIndicator tasks={tasks} />);
    expect(container.querySelector(".task-indicator")).toBeNull();
  });

  it("applies custom className", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Active" },
    ];
    const { container } = render(<TaskIndicator tasks={tasks} className="my-custom" />);
    const indicator = container.querySelector(".task-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator!.classList.contains("my-custom")).toBe(true);
  });

  it("renders multiple running tasks simultaneously", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Task A" },
      { id: "t2", agentType: "explore", status: "running" as const, description: "Task B" },
      { id: "t3", agentType: "browser", status: "running" as const, description: "Task C" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Exploring")).toBeTruthy();
    expect(screen.getByText("Browsing")).toBeTruthy();
    expect(screen.getByText("Task A")).toBeTruthy();
    expect(screen.getByText("Task B")).toBeTruthy();
    expect(screen.getByText("Task C")).toBeTruthy();
  });

  it("shows description when statusText is undefined", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "Fallback desc" },
    ];
    render(<TaskIndicator tasks={tasks} />);
    expect(screen.getByText("Fallback desc")).toBeTruthy();
  });

  it("renders spinner for each running task", () => {
    const tasks = [
      { id: "t1", agentType: "general", status: "running" as const, description: "A" },
      { id: "t2", agentType: "explore", status: "running" as const, description: "B" },
    ];
    const { container } = render(<TaskIndicator tasks={tasks} />);
    const spinners = container.querySelectorAll("[data-component='spinner']");
    expect(spinners.length).toBe(2);
  });
});
