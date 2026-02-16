import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MiniOutput } from "./MiniOutput";

vi.mock("../ConversationEvents", () => ({
  ConversationEvents: (props: Record<string, unknown>) => (
    <div data-testid="conversation-events" data-maxitems={props.maxItems} />
  ),
}));

function defaultProps(overrides: Partial<Parameters<typeof MiniOutput>[0]> = {}) {
  return {
    events: [],
    streamingText: "",
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null as string | null,
    showConversation: false,
    ...overrides,
  };
}

describe("MiniOutput", () => {
  it("does not render ConversationEvents when showConversation is false", () => {
    const { container } = render(
      <MiniOutput {...defaultProps({ showConversation: false })} />,
    );
    expect(container.querySelector("[data-testid='conversation-events']")).toBeNull();
  });

  it("renders ConversationEvents when showConversation is true", () => {
    const { container } = render(
      <MiniOutput {...defaultProps({ showConversation: true })} />,
    );
    expect(container.querySelector("[data-testid='conversation-events']")).toBeTruthy();
  });

  it("always has class mini-content", () => {
    const { container } = render(
      <MiniOutput {...defaultProps({ showConversation: false })} />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.classList.contains("mini-content")).toBe(true);
  });

  it("has class has-messages when showConversation is true", () => {
    const { container } = render(
      <MiniOutput {...defaultProps({ showConversation: true })} />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.classList.contains("has-messages")).toBe(true);
  });

  it("has classes at-top and at-bottom by default", () => {
    const { container } = render(
      <MiniOutput {...defaultProps()} />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.classList.contains("at-top")).toBe(true);
    expect(root.classList.contains("at-bottom")).toBe(true);
  });
});
