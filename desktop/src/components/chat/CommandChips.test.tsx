import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandChips } from "./CommandChips";

describe("CommandChips", () => {
  const suggestions = [
    { commandId: "a", name: "Search", description: "Find items" },
    { commandId: "b", name: "Summarize", description: "Summarize notes" },
  ];

  it("renders nothing when suggestions are empty", () => {
    const { container } = render(
      <CommandChips suggestions={[]} onSelect={() => {}} />
    );
    expect(container.querySelector(".command-chips")).toBeNull();
  });

  it("renders chip buttons for each suggestion", () => {
    render(<CommandChips suggestions={suggestions} onSelect={() => {}} />);
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getByText("Summarize")).toBeTruthy();
  });

  it("calls onSelect with the clicked suggestion", () => {
    const onSelect = vi.fn();
    render(<CommandChips suggestions={suggestions} onSelect={onSelect} />);

    fireEvent.click(screen.getByText("Search"));
    expect(onSelect).toHaveBeenCalledWith(suggestions[0]);

    fireEvent.click(screen.getByText("Summarize"));
    expect(onSelect).toHaveBeenCalledWith(suggestions[1]);
  });

  it("sets description as title attribute", () => {
    render(<CommandChips suggestions={suggestions} onSelect={() => {}} />);
    const searchButton = screen.getByText("Search");
    expect(searchButton.getAttribute("title")).toBe("Find items");
  });

  it("renders a single suggestion correctly", () => {
    const single = [{ commandId: "x", name: "Run", description: "Run it" }];
    render(<CommandChips suggestions={single} onSelect={() => {}} />);
    expect(screen.getByText("Run")).toBeTruthy();
  });

  it("renders buttons with command-chip class", () => {
    const { container } = render(
      <CommandChips suggestions={suggestions} onSelect={() => {}} />
    );
    const chips = container.querySelectorAll(".command-chip");
    expect(chips.length).toBe(2);
  });

  it("wraps chips in a command-chips container", () => {
    const { container } = render(
      <CommandChips suggestions={suggestions} onSelect={() => {}} />
    );
    expect(container.querySelector(".command-chips")).toBeTruthy();
  });

  it("does not call onSelect until clicked", () => {
    const onSelect = vi.fn();
    render(<CommandChips suggestions={suggestions} onSelect={onSelect} />);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders all buttons as button elements", () => {
    render(<CommandChips suggestions={suggestions} onSelect={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(2);
  });

  it("sets title on each chip from its description", () => {
    render(<CommandChips suggestions={suggestions} onSelect={() => {}} />);
    expect(screen.getByText("Summarize").getAttribute("title")).toBe("Summarize notes");
  });
});
