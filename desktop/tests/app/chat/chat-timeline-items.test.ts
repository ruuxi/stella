import { describe, expect, it } from "vitest";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";
import { buildChatTimelineItems } from "@/features/chat/lib/chat-timeline-items";

const user = (id: string, text = id): EventRowViewModel => ({
  kind: "user",
  id,
  text,
  attachments: [],
});

const assistant = (
  id: string,
  text: string,
  isStreaming = false,
): EventRowViewModel => ({
  kind: "assistant",
  id,
  cacheKey: id,
  text,
  ...(isStreaming ? { isStreaming: true } : {}),
});

const queued = (
  id: string,
  queueOrder: number,
): QueuedUserMessage => ({
  id,
  text: id,
  timestamp: 100 + queueOrder,
  queueOrder,
});

const identity = (item: ReturnType<typeof buildChatTimelineItems>[number]) =>
  `${item.type}:${item.id}`;

describe("buildChatTimelineItems", () => {
  it("places a queued send below the assistant that is actively streaming", () => {
    const items = buildChatTimelineItems({
      rows: [user("u1"), assistant("assistant-active", "still streaming", true)],
      queuedUserMessages: [queued("u2", 1)],
      includeWorkingIndicator: true,
    });

    expect(items.map(identity)).toEqual([
      "message:u1",
      "message:assistant-active",
      "working-indicator:chat-timeline:working-indicator",
      "queued-user:u2",
    ]);
  });

  it("keeps multiple queued sends monotonic beneath every assistant segment", () => {
    const items = buildChatTimelineItems({
      rows: [
        user("u1"),
        assistant("assistant-preamble", "I will check."),
        // Empty streaming slots still represent the active post-tool segment.
        assistant("assistant-post-tool", "", true),
      ],
      queuedUserMessages: [queued("u3", 2), queued("u2", 1)],
      includeWorkingIndicator: true,
    });

    expect(items.map(identity)).toEqual([
      "message:u1",
      "message:assistant-preamble",
      "message:assistant-post-tool",
      "working-indicator:chat-timeline:working-indicator",
      "queued-user:u2",
      "queued-user:u3",
    ]);
  });

  it("preserves the queued id and assistant predecessor when drain makes it a sent row", () => {
    const activeRows = [
      user("u1"),
      assistant("assistant-preamble", "I will check."),
      assistant("assistant-post-tool", "Done.", true),
    ];
    const queuedItems = buildChatTimelineItems({
      rows: activeRows,
      queuedUserMessages: [queued("u2", 1)],
      includeWorkingIndicator: true,
    });
    const sentItems = buildChatTimelineItems({
      rows: [...activeRows, user("u2", "follow up")],
      queuedUserMessages: [],
      includeWorkingIndicator: true,
    });

    const queuedItem = queuedItems.find((item) => item.id === "u2");
    const sentItem = sentItems.find((item) => item.id === "u2");
    expect(queuedItem).toMatchObject({ id: "u2", type: "queued-user" });
    expect(sentItem).toMatchObject({ id: "u2", type: "message" });

    const visibleIds = (items: typeof queuedItems) =>
      items
        .filter((item) => item.type !== "working-indicator")
        .map((item) => item.id);
    expect(visibleIds(queuedItems)).toEqual([
      "u1",
      "assistant-preamble",
      "assistant-post-tool",
      "u2",
    ]);
    expect(visibleIds(sentItems)).toEqual(visibleIds(queuedItems));
  });

  it("lets a canonical row win an overlap frame without a duplicate key", () => {
    const items = buildChatTimelineItems({
      rows: [user("u1"), assistant("a1", "done"), user("u2")],
      queuedUserMessages: [queued("u2", 1)],
      includeWorkingIndicator: false,
    });

    expect(items.filter((item) => item.id === "u2")).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ id: "u2", type: "message" });
  });
});
