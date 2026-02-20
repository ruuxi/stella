import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EventRecord, Attachment } from "../../hooks/use-conversation-events";

vi.mock("./WorkingIndicator", () => ({
  WorkingIndicator: (props: Record<string, unknown>) => (
    <div data-testid="working-indicator" data-tool={props.toolName} />
  ),
}));
vi.mock("./Markdown", () => ({
  Markdown: (props: { text: string }) => (
    <div data-testid="markdown">{props.text}</div>
  ),
}));
vi.mock("./emotes/message-source", () => ({
  isOrchestratorChatMessagePayload: () => true,
}));

import { MessageGroup } from "./MessageGroup";

const makeEvent = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  _id: "evt-1",
  timestamp: Date.now(),
  type: "message",
  ...overrides,
});

describe("MessageGroup", () => {
  it("renders user message text", () => {
    const userMessage = makeEvent({
      payload: { text: "Hello from user" },
    });
    render(<MessageGroup userMessage={userMessage} />);
    expect(screen.getByText("Hello from user")).toBeTruthy();
  });

  it("renders empty text for missing payload", () => {
    const userMessage = makeEvent({ payload: undefined });
    const { container } = render(<MessageGroup userMessage={userMessage} />);
    const eventBody = container.querySelector(".event-body");
    expect(eventBody).toBeTruthy();
    expect(eventBody!.textContent).toBe("");
  });

  it("shows assistant message via Markdown when not streaming", () => {
    const userMessage = makeEvent({ payload: { text: "Hi" } });
    const assistantMessage = makeEvent({
      _id: "evt-2",
      payload: { text: "Hello back" },
    });
    render(
      <MessageGroup
        userMessage={userMessage}
        assistantMessage={assistantMessage}
        isStreaming={false}
      />,
    );
    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Hello back");
  });

  it("shows WorkingIndicator when streaming without assistant message", () => {
    const userMessage = makeEvent({ payload: { text: "Question?" } });
    render(
      <MessageGroup userMessage={userMessage} isStreaming={true} />,
    );
    expect(screen.getByTestId("working-indicator")).toBeTruthy();
  });

  it("hides WorkingIndicator when assistant message exists", () => {
    const userMessage = makeEvent({ payload: { text: "Q" } });
    const assistantMessage = makeEvent({
      _id: "evt-2",
      payload: { text: "A" },
    });
    render(
      <MessageGroup
        userMessage={userMessage}
        assistantMessage={assistantMessage}
        isStreaming={true}
      />,
    );
    expect(screen.queryByTestId("working-indicator")).toBeNull();
  });

  it("renders image attachments", () => {
    const userMessage = makeEvent({
      payload: {
        text: "See image",
        attachments: [
          { id: "att-1", url: "https://example.com/img.png", mimeType: "image/png" },
        ],
      },
    });
    render(<MessageGroup userMessage={userMessage} />);
    const img = screen.getByAltText("Attachment");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("https://example.com/img.png");
  });

  it("renders fallback for non-URL attachments", () => {
    const userMessage = makeEvent({
      payload: {
        text: "File attached",
        attachments: [{ id: "att-1", name: "document.pdf" }],
      },
    });
    render(<MessageGroup userMessage={userMessage} />);
    expect(screen.getByText("Attachment 1")).toBeTruthy();
  });

  it("renders fallback for unsafe attachment URL schemes", () => {
    const userMessage = makeEvent({
      payload: {
        text: "Unsafe attached",
        attachments: [{ id: "att-1", url: "javascript:alert(1)" }],
      },
    });
    render(<MessageGroup userMessage={userMessage} />);
    expect(screen.queryByAltText("Attachment")).toBeNull();
    expect(screen.getByText("Attachment 1")).toBeTruthy();
  });

  it("calls onOpenAttachment when clicking attachment", () => {
    const onOpen = vi.fn();
    const attachment: Attachment = {
      id: "att-1",
      url: "https://example.com/img.png",
      mimeType: "image/png",
    };
    const userMessage = makeEvent({
      payload: { text: "Photo", attachments: [attachment] },
    });
    render(
      <MessageGroup userMessage={userMessage} onOpenAttachment={onOpen} />,
    );
    fireEvent.click(screen.getByAltText("Attachment"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(attachment);
  });

  it("keyboard handler on attachment triggers callback with Enter and Space", () => {
    const onOpen = vi.fn();
    const attachment: Attachment = {
      id: "att-1",
      url: "https://example.com/img.png",
    };
    const userMessage = makeEvent({
      payload: { text: "Photo", attachments: [attachment] },
    });
    render(
      <MessageGroup userMessage={userMessage} onOpenAttachment={onOpen} />,
    );
    const img = screen.getByAltText("Attachment");

    fireEvent.keyDown(img, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(img, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);

    // Other keys should not trigger
    fireEvent.keyDown(img, { key: "Tab" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("shows streaming text via Markdown when streaming with text", () => {
    const userMessage = makeEvent({ payload: { text: "Tell me" } });
    render(
      <MessageGroup
        userMessage={userMessage}
        isStreaming={true}
        streamingText="Partial response..."
      />,
    );
    // WorkingIndicator should be present (no assistant message)
    expect(screen.getByTestId("working-indicator")).toBeTruthy();
    // Markdown should render the streaming text
    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Partial response...");
  });
});
