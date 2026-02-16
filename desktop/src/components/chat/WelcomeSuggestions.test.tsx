import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeSuggestions } from "./WelcomeSuggestions";

describe("WelcomeSuggestions", () => {
  const suggestions = [
    { category: "skill" as const, title: "Web Search", description: "Search the web", prompt: "search for X" },
    { category: "cron" as const, title: "Daily Check", description: "Run daily", prompt: "check daily" },
    { category: "app" as const, title: "Weather", description: "Show weather", prompt: "show weather" },
  ];

  it("renders nothing when suggestions are empty", () => {
    const { container } = render(
      <WelcomeSuggestions suggestions={[]} onSelect={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders suggestion buttons", () => {
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    expect(screen.getByText("Web Search")).toBeTruthy();
    expect(screen.getByText("Daily Check")).toBeTruthy();
    expect(screen.getByText("Weather")).toBeTruthy();
  });

  it("calls onSelect when suggestion is clicked", () => {
    const onSelect = vi.fn();
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={onSelect} />
    );

    fireEvent.click(screen.getByText("Web Search"));
    expect(onSelect).toHaveBeenCalledWith(suggestions[0]);
  });

  it("shows description text", () => {
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    expect(screen.getByText("Search the web")).toBeTruthy();
  });

  it("shows correct category badge labels", () => {
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(screen.getByText("Automation")).toBeTruthy();
    expect(screen.getByText("App")).toBeTruthy();
  });

  it("sets data-category attribute on card buttons", () => {
    const { container } = render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    const cards = container.querySelectorAll(".welcome-suggestion-card");
    expect(cards.length).toBe(3);
    expect(cards[0].getAttribute("data-category")).toBe("skill");
    expect(cards[1].getAttribute("data-category")).toBe("cron");
    expect(cards[2].getAttribute("data-category")).toBe("app");
  });

  it("sets data-category attribute on badge elements", () => {
    const { container } = render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    const badges = container.querySelectorAll(".welcome-suggestion-badge");
    expect(badges.length).toBe(3);
    expect(badges[0].getAttribute("data-category")).toBe("skill");
    expect(badges[1].getAttribute("data-category")).toBe("cron");
    expect(badges[2].getAttribute("data-category")).toBe("app");
  });

  it("calls onSelect with the correct suggestion on each click", () => {
    const onSelect = vi.fn();
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={onSelect} />
    );

    fireEvent.click(screen.getByText("Daily Check"));
    expect(onSelect).toHaveBeenCalledWith(suggestions[1]);

    fireEvent.click(screen.getByText("Weather"));
    expect(onSelect).toHaveBeenCalledWith(suggestions[2]);
  });

  it("shows all descriptions", () => {
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    expect(screen.getByText("Search the web")).toBeTruthy();
    expect(screen.getByText("Run daily")).toBeTruthy();
    expect(screen.getByText("Show weather")).toBeTruthy();
  });

  it("renders a single suggestion", () => {
    const single = [
      { category: "app" as const, title: "Solo", description: "Solo desc", prompt: "solo prompt" },
    ];
    render(<WelcomeSuggestions suggestions={single} onSelect={() => {}} />);
    expect(screen.getByText("Solo")).toBeTruthy();
    expect(screen.getByText("App")).toBeTruthy();
  });

  it("renders buttons as button elements", () => {
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={() => {}} />
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(3);
  });

  it("does not call onSelect without user interaction", () => {
    const onSelect = vi.fn();
    render(
      <WelcomeSuggestions suggestions={suggestions} onSelect={onSelect} />
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
