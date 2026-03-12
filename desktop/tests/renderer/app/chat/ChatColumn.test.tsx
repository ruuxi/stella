import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import { ChatColumn } from "../../../../src/app/chat/ChatColumn";
import type { ChatColumnProps } from "../../../../src/app/chat/ChatColumn";

vi.mock("../../../../src/app/chat/ConversationEvents", () => ({
  ConversationEvents: () => <div data-testid="conversation-events" />,
}));

vi.mock("../../../../src/app/chat/Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("@/app/chat/CommandChips", () => ({
  CommandChips: () => <div data-testid="command-chips" />,
}));

vi.mock("@/app/chat/hooks/use-command-suggestions", () => ({
  useCommandSuggestions: () => [],
}));

function makeProps(overrides: Partial<ChatColumnProps> = {}): ChatColumnProps {
  const {
    conversation: conversationOverrides = {},
    composer: composerOverrides = {},
    scroll: scrollOverrides = {},
    ...restOverrides
  } = overrides;
  const {
    streaming: conversationStreamingOverrides,
    history: conversationHistoryOverrides,
    ...conversationRestOverrides
  } = conversationOverrides;

  return {
    conversation: {
      events: [],
      streaming: {
        text: "",
        reasoningText: "",
        isStreaming: false,
        pendingUserMessageId: null,
        selfModMap: {},
        ...(conversationStreamingOverrides ?? {}),
      },
      history: {
        hasOlderEvents: false,
        isLoadingOlder: false,
        isInitialLoading: false,
        ...(conversationHistoryOverrides ?? {}),
      },
      ...conversationRestOverrides,
    },
    composer: {
      message: "",
      setMessage: vi.fn(),
      chatContext: null,
      setChatContext: vi.fn(),
      selectedText: null,
      setSelectedText: vi.fn(),
      canSubmit: true,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onCommandSelect: vi.fn(),
      ...composerOverrides,
    },
    scroll: {
      setViewportElement: vi.fn(),
      setContentElement: vi.fn(),
      onScroll: vi.fn(),
      showScrollButton: false,
      scrollToBottom: vi.fn(),
      overflowAnchor: "none",
      thumbState: { top: 0, height: 0, visible: false },
      ...scrollOverrides,
    },
    conversationId: null,
    ...restOverrides,
  };
}

describe("ChatColumn", () => {
  it("shows ConversationEvents", () => {
    render(<ChatColumn {...makeProps()} />);
    expect(screen.getByTestId("conversation-events")).toBeTruthy();
  });

  it("shows Composer", () => {
    render(<ChatColumn {...makeProps()} />);
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("shows scroll-to-bottom button when showScrollButton=true", () => {
    const events: EventRecord[] = [
      { _id: "event-1", timestamp: 1, type: "user_message", payload: { text: "hi" } },
    ];
    render(
      <ChatColumn
        {...makeProps({
          conversation: {
            events,
          } as ChatColumnProps["conversation"],
          scroll: {
            showScrollButton: true,
          } as ChatColumnProps["scroll"],
        })}
      />,
    );
    expect(screen.getByLabelText("Scroll to bottom")).toBeTruthy();
  });

  it('calls scrollToBottom("smooth") when scroll button clicked', () => {
    const scrollToBottom = vi.fn();
    const events: EventRecord[] = [
      { _id: "event-1", timestamp: 1, type: "user_message", payload: { text: "hi" } },
    ];
    render(
      <ChatColumn
        {...makeProps({
          conversation: {
            events,
          } as ChatColumnProps["conversation"],
          scroll: {
            showScrollButton: true,
            scrollToBottom,
          } as ChatColumnProps["scroll"],
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Scroll to bottom"));
    expect(scrollToBottom).toHaveBeenCalledWith("smooth");
  });

  it("has class full-body-main", () => {
    const { container } = render(<ChatColumn {...makeProps()} />);
    expect(container.querySelector(".full-body-main")).toBeTruthy();
  });

  it("applies composer-wrap--entering class when composerEntering is true", () => {
    const { container } = render(
      <ChatColumn {...makeProps({ composerEntering: true })} />,
    );
    expect(container.querySelector(".composer-wrap--entering")).toBeTruthy();
  });

  it("does not apply composer-wrap--entering class by default", () => {
    const { container } = render(<ChatColumn {...makeProps()} />);
    expect(container.querySelector(".composer-wrap--entering")).toBeNull();
  });
});



