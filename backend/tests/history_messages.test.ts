import { describe, expect, test } from "bun:test";
import { eventsToHistoryMessages } from "../convex/lib/history_messages";

const baseEvent = {
  _id: "event_1",
  _creationTime: 0,
  conversationId: "conversation_1",
  timestamp: 0,
  payload: {},
};

describe("history message formatting", () => {
  test("replays user and assistant messages", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_user",
        type: "user_message",
        payload: { text: "Open Microsoft Word" },
      },
      {
        ...baseEvent,
        _id: "event_assistant",
        type: "assistant_message",
        payload: { text: "Trying that now." },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Open Microsoft Word");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toContain("Trying that now.");
  });

  test("replays task lifecycle events", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_task_started",
        type: "task_started",
        payload: {
          taskId: "task_1",
          description: "Open Microsoft Word",
          agentType: "general",
        },
      },
      {
        ...baseEvent,
        _id: "event_task_completed",
        type: "task_completed",
        payload: {
          taskId: "task_1",
          result: "Word launched.",
        },
      },
      {
        ...baseEvent,
        _id: "event_task_failed",
        type: "task_failed",
        payload: {
          taskId: "task_2",
          error: "Tool timed out",
        },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toContain("[Task started] Open Microsoft Word");
    expect(messages[1]?.content).toContain("[Task completed]");
    expect(messages[2]?.content).toContain("[Task failed]");
  });

  test("ignores unrelated internal events", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_internal",
        type: "screen_event",
        payload: { text: "something" },
      },
      {
        ...baseEvent,
        _id: "event_user_valid",
        type: "user_message",
        payload: { text: "Hello" },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Hello");
  });

  test("emits a microcompact boundary for oversized attachment history", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_user_with_attachment",
        timestamp: 1,
        type: "user_message",
        payload: {
          text: "Here's the screenshot.",
          attachments: Array.from({ length: 16 }, (_, index) => ({
            id: `attachment_${index + 1}`,
          })),
        },
      },
      {
        ...baseEvent,
        _id: "event_assistant_after_attachment",
        timestamp: 2,
        type: "assistant_message",
        payload: { text: "I can see it." },
      },
    ] as unknown[];

    const result = eventsToHistoryMessages(events, {
      microcompact: {
        trigger: "manual",
        keepTokens: 1,
      },
    });

    expect(result.microcompactBoundary).toBeDefined();
    expect(result.microcompactBoundary?.compactedToolIds).toEqual([]);
    expect(result.microcompactBoundary?.clearedAttachmentUUIDs).toHaveLength(16);
  });
});
