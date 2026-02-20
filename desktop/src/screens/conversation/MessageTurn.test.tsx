import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../hooks/use-conversation-events";
import {
  TurnItem,
  attachmentsEqual,
  getAttachments,
  getChannelEnvelope,
  getEventText,
} from "./MessageTurn";

const createEvent = (
  overrides: Partial<EventRecord> & { type?: string },
): EventRecord => ({
  _id: "event-1",
  timestamp: Date.now(),
  type: "user_message",
  ...overrides,
});

describe("MessageTurn helpers", () => {
  it("extracts text from message payload variants", () => {
    expect(getEventText(createEvent({ payload: { text: "hello" } }))).toBe("hello");
    expect(getEventText(createEvent({ payload: { content: "hi" } }))).toBe("hi");
    expect(getEventText(createEvent({ payload: { message: "ping" } }))).toBe("ping");
    expect(getEventText(createEvent({ payload: undefined }))).toBe("");
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
});
