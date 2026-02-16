import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReasoningSection } from "./ReasoningSection";

// Mock the Markdown component to avoid streamdown complexity
vi.mock("./Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));

describe("ReasoningSection", () => {
  it("renders nothing when no content and not streaming", () => {
    const { container } = render(
      <ReasoningSection content="" isStreaming={false} />
    );
    expect(container.querySelector(".reasoning-section")).toBeNull();
  });

  it("shows content when streaming", () => {
    render(<ReasoningSection content="thinking about this..." isStreaming={true} />);
    expect(screen.getByText("thinking about this...")).toBeTruthy();
  });

  it("shows Thinking... placeholder when streaming with no content", () => {
    render(<ReasoningSection content="" isStreaming={true} />);
    expect(screen.getByText("Thinking...")).toBeTruthy();
  });

  it("shows toggle button when not streaming", () => {
    render(<ReasoningSection content="some reasoning" isStreaming={false} />);
    const button = screen.getByRole("button");
    expect(button).toBeTruthy();
    expect(screen.getByText("Reasoning")).toBeTruthy();
  });

  it("does not show toggle button when streaming", () => {
    render(<ReasoningSection content="reasoning" isStreaming={true} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("toggles collapse on button click", () => {
    const { container } = render(
      <ReasoningSection content="reasoning text" isStreaming={false} />
    );

    // Initially expanded
    expect(screen.getByText("reasoning text")).toBeTruthy();

    // Click to collapse
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("[data-expanded='false']")).toBeTruthy();

    // Click to expand again
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("[data-expanded='true']")).toBeTruthy();
    expect(screen.getByText("reasoning text")).toBeTruthy();
  });

  it("sets data-streaming attribute correctly when streaming", () => {
    const { container } = render(
      <ReasoningSection content="text" isStreaming={true} />
    );
    expect(container.querySelector("[data-streaming='true']")).toBeTruthy();
  });

  it("sets data-streaming attribute to false when not streaming", () => {
    const { container } = render(
      <ReasoningSection content="text" isStreaming={false} />
    );
    expect(container.querySelector("[data-streaming='false']")).toBeTruthy();
  });

  it("is expanded by default when not streaming and user has not collapsed", () => {
    const { container } = render(
      <ReasoningSection content="reasoning" isStreaming={false} />
    );
    expect(container.querySelector("[data-expanded='true']")).toBeTruthy();
    expect(screen.getByText("reasoning")).toBeTruthy();
  });

  it("applies custom className", () => {
    const { container } = render(
      <ReasoningSection content="text" isStreaming={false} className="my-class" />
    );
    const section = container.querySelector(".reasoning-section");
    expect(section).toBeTruthy();
    expect(section!.classList.contains("my-class")).toBe(true);
  });

  it("streaming overrides user collapse (always expanded while streaming)", () => {
    const { container, rerender } = render(
      <ReasoningSection content="text" isStreaming={false} />
    );

    // User collapses
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("[data-expanded='false']")).toBeTruthy();

    // Switch to streaming - should force expand
    rerender(<ReasoningSection content="text" isStreaming={true} />);
    expect(container.querySelector("[data-expanded='true']")).toBeTruthy();
  });

  it("passes isAnimating to Markdown when streaming", () => {
    render(<ReasoningSection content="content" isStreaming={true} />);
    const md = screen.getByTestId("markdown");
    expect(md).toBeTruthy();
    expect(md.textContent).toBe("content");
  });

  it("hides body content when collapsed and not streaming", () => {
    const { container } = render(
      <ReasoningSection content="hidden text" isStreaming={false} />
    );

    // Collapse it
    fireEvent.click(screen.getByRole("button"));
    // When collapsed + not streaming, body should not render
    expect(container.querySelector(".reasoning-body")).toBeNull();
  });

  it("defaults isStreaming to false", () => {
    const { container } = render(
      <ReasoningSection content="defaults" />
    );
    // Should show the toggle button (only shown when not streaming)
    expect(screen.getByRole("button")).toBeTruthy();
    expect(container.querySelector("[data-streaming='false']")).toBeTruthy();
  });
});
