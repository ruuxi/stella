import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import { getEventText } from "@/app/chat/lib/event-transforms";

const { markdownRenderMock } = vi.hoisted(() => ({
  markdownRenderMock: vi.fn(({ text }: { text: string }) => (
    <div data-testid="markdown">{text}</div>
  )),
}));

vi.mock("../../../../src/app/chat/Markdown", () => ({
  Markdown: (props: { text: string }) => markdownRenderMock(props),
}));

import {
  TurnItem,
  attachmentsEqual,
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from "../../../../src/app/chat/MessageTurn";

const createEvent = (
  overrides: Partial<EventRecord> & { type?: string },
): EventRecord => ({
  _id: "event-1",
  timestamp: Date.now(),
  type: "user_message",
  ...overrides,
});

describe("MessageTurn helpers", () => {
  it("extracts text from message payload", () => {
    expect(getEventText(createEvent({ payload: { text: "hello" } }))).toBe("hello");
    expect(getEventText(createEvent({ payload: { content: "hi" } }))).toBe("");
    expect(getEventText(createEvent({ payload: { message: "ping" } }))).toBe("");
    expect(getEventText(createEvent({ payload: undefined }))).toBe("");
  });

  it("keeps raw channel text intact in event payload accessors", () => {
    expect(
      getEventText(
        createEvent({
          payload: { text: "[8:00 PM] hello there\n\n[1:00 PM, Mar 8]", source: "channel:discord" },
        }),
      ),
    ).toBe("[8:00 PM] hello there\n\n[1:00 PM, Mar 8]");
  });

  it("strips stored channel timestamps only in rendered text", () => {
    expect(
      getDisplayUserText(
        createEvent({
          payload: {
            text: "[8:00 PM] hello there\n\n[1:00 PM, Mar 8]",
            source: "channel:discord",
          },
        }),
      ),
    ).toBe("hello there");

    expect(
      getDisplayUserText(
        createEvent({
          payload: { text: "[08:00 pm] hello again\n\n[1:00 PM, Mar 8]" },
          channelEnvelope: {
            provider: "discord",
            kind: "message",
          },
        }),
      ),
    ).toBe("hello again");

    expect(
      getDisplayMessageText(
        createEvent({
          type: "assistant_message",
          payload: {
            text: "[8:00 PM] channel reply\n\n[1:05 PM, Mar 8]",
            source: "channel:discord",
          },
        }),
      ),
    ).toBe("channel reply");
  });

  it("preserves intentional leading time tags but strips stored suffix tags for non-channel messages", () => {
    expect(
      getEventText(
        createEvent({
          payload: { text: "[8:00 PM] this is intentional\n\n[1:00 PM, Mar 8]" },
        }),
      ),
    ).toBe("[8:00 PM] this is intentional\n\n[1:00 PM, Mar 8]");
    expect(
      getDisplayUserText(
        createEvent({
          payload: { text: "[8:00 PM] this is intentional\n\n[1:00 PM, Mar 8]" },
        }),
      ),
    ).toBe("[8:00 PM] this is intentional");
  });

  it("merges payload and channel-envelope attachments with dedupe", () => {
    const shared = {
      id: "a-1",
      url: "https://cdn.example.com/file.png",
      name: "file.png",
      mimeType: "image/png",
      kind: "image",
    };

    const merged = getAttachments(
      createEvent({
        payload: { attachments: [shared] },
        channelEnvelope: {
          provider: "discord",
          kind: "message",
          attachments: [
            shared,
            { id: "a-2", name: "voice-note", kind: "voice_note" },
          ],
        },
      }),
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject(shared);
    expect(merged[1]).toMatchObject({ id: "a-2" });
  });

  it("returns the channel envelope when present", () => {
    const envelope = {
      provider: "slack",
      kind: "reaction" as const,
      reactions: [{ emoji: "??", action: "add" as const }],
    };
    expect(getChannelEnvelope(createEvent({ channelEnvelope: envelope }))).toEqual(envelope);
    expect(getChannelEnvelope(createEvent({ channelEnvelope: undefined }))).toBeUndefined();
  });

  it("compares attachment arrays by relevant fields", () => {
    const a = [{ id: "1", url: "u", mimeType: "image/png", name: "n" }];
    const b = [{ id: "1", url: "u", mimeType: "image/png", name: "n" }];
    const c = [{ id: "1", url: "u", mimeType: "image/jpeg", name: "n" }];

    expect(attachmentsEqual(a, b)).toBe(true);
    expect(attachmentsEqual(a, c)).toBe(false);
  });
});

describe("TurnItem", () => {
  it("does not rerender unchanged assistant markdown when turn identity changes", () => {
    markdownRenderMock.mockClear();

    const turn = {
      id: "turn-stable",
      userText: "hello",
      userAttachments: [],
      assistantText: "assistant reply",
      assistantMessageId: "assistant-1",
      assistantEmotesEnabled: true,
    };

    const { rerender } = render(<TurnItem turn={turn} />);

    expect(markdownRenderMock).toHaveBeenCalledTimes(1);

    rerender(
      <TurnItem
        turn={{
          ...turn,
          userAttachments: [],
        }}
      />,
    );

    expect(markdownRenderMock).toHaveBeenCalledTimes(1);
  });

  it("rerenders assistant markdown when assistant content changes", () => {
    markdownRenderMock.mockClear();

    const turn = {
      id: "turn-change",
      userText: "hello",
      userAttachments: [],
      assistantText: "assistant reply",
      assistantMessageId: "assistant-1",
      assistantEmotesEnabled: true,
    };

    const { rerender } = render(<TurnItem turn={turn} />);

    expect(markdownRenderMock).toHaveBeenCalledTimes(1);

    rerender(
      <TurnItem
        turn={{
          ...turn,
          assistantText: "assistant reply updated",
        }}
      />,
    );

    expect(markdownRenderMock).toHaveBeenCalledTimes(2);
  });

  it("renders connector metadata badges and fallback attachment labels", () => {
    render(
      <TurnItem
        turn={{
          id: "turn-1",
          userText: "hello",
          userAttachments: [{ id: "att-1", kind: "voice_note" }],
          userChannelEnvelope: {
            provider: "google_chat",
            kind: "reaction",
            reactions: [{ emoji: "??", action: "add" }],
          },
          assistantText: "",
          assistantMessageId: null,
          assistantEmotesEnabled: false,
        }}
      />,
    );

    expect(screen.getByText("Google Chat")).toBeInTheDocument();
    expect(screen.getByText("reaction")).toBeInTheDocument();
    expect(screen.getByText("Reactions +??")).toBeInTheDocument();
    expect(screen.getByText("Voice note")).toBeInTheDocument();
  });

  it("invokes attachment open callback when image is clicked", () => {
    const onOpenAttachment = vi.fn();

    render(
      <TurnItem
        turn={{
          id: "turn-2",
          userText: "image",
          userAttachments: [{ id: "img-1", url: "https://cdn.example.com/img.png" }],
          assistantText: "",
          assistantMessageId: null,
          assistantEmotesEnabled: false,
        }}
        onOpenAttachment={onOpenAttachment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Attachment" }));
    expect(onOpenAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "img-1" }),
    );
  });

  it("renders fallback label for unsafe attachment URL schemes", () => {
    render(
      <TurnItem
        turn={{
          id: "turn-unsafe",
          userText: "unsafe",
          userAttachments: [{ id: "img-1", url: "javascript:alert(1)" }],
          assistantText: "",
          assistantMessageId: null,
          assistantEmotesEnabled: false,
        }}
      />,
    );

    expect(screen.queryByRole("img", { name: "Attachment" })).toBeNull();
    expect(screen.getByText("Attachment 1")).toBeInTheDocument();
  });

  it("renders the web search briefing badge without requiring assistant text", () => {
    const { container } = render(
      <TurnItem
        turn={{
          id: "turn-badge",
          userText: "search the web",
          userAttachments: [],
          assistantText: "",
          assistantMessageId: null,
          assistantEmotesEnabled: false,
          webSearchBadgeHtml: "<section><h3>Top story</h3><p>Summary</p></section>",
        }}
      />,
    );

    expect(screen.getByText("Search briefing")).toBeInTheDocument();
    expect(screen.getByText("Top story")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(container.querySelector(".event-search-badge")).toBeTruthy();
  });
});




