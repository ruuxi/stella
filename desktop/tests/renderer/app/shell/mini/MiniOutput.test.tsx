import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { MiniOutput } from "../../../../../src/app/shell/mini/MiniOutput";

vi.mock("@/app/chat/ConversationEvents", () => ({
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

function mockScrollableMetrics(
  element: HTMLElement,
  {
    clientHeight = 400,
    scrollHeight = 1000,
    scrollTop = 0,
  }: {
    clientHeight?: number;
    scrollHeight?: number;
    scrollTop?: number;
  } = {},
) {
  let currentScrollTop = scrollTop;

  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });

  return {
    getScrollTop: () => currentScrollTop,
    setScrollTop: (value: number) => {
      currentScrollTop = value;
    },
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

  it("keeps auto-scrolling while the user is pinned to the bottom", () => {
    const { container, rerender } = render(
      <MiniOutput {...defaultProps({ showConversation: true, streamingText: "Hello" })} />,
    );
    const root = container.firstChild as HTMLElement;
    const scroll = mockScrollableMetrics(root, { scrollTop: 600 });

    rerender(
      <MiniOutput
        {...defaultProps({ showConversation: true, streamingText: "Hello there" })}
      />,
    );

    expect(scroll.getScrollTop()).toBe(1000);
  });

  it("does not force-scroll when the user has scrolled up during streaming", () => {
    const { container, rerender } = render(
      <MiniOutput {...defaultProps({ showConversation: true, streamingText: "Hello" })} />,
    );
    const root = container.firstChild as HTMLElement;
    const scroll = mockScrollableMetrics(root, { scrollTop: 600 });

    scroll.setScrollTop(200);
    fireEvent.scroll(root);

    rerender(
      <MiniOutput
        {...defaultProps({ showConversation: true, streamingText: "Hello there" })}
      />,
    );

    expect(scroll.getScrollTop()).toBe(200);
  });
});

