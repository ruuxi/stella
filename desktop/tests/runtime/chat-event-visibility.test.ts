import { describe, expect, it } from "vitest";
import {
  countVisibleChatMessageEvents,
  isUiDisplayableChatEvent,
  sliceEventsByVisibleMessageWindow,
} from "../../../runtime/chat-event-visibility";

type TestEvent = {
  _id: string;
  timestamp: number;
  type: string;
  payload?: Record<string, unknown>;
};

const event = (
  id: string,
  type: string,
  timestamp: number,
  payload?: Record<string, unknown>,
): TestEvent => ({
  _id: id,
  timestamp,
  type,
  ...(payload ? { payload } : {}),
});

describe("chat-event-visibility", () => {
  it("hides message events explicitly marked invisible by metadata", () => {
    expect(
      isUiDisplayableChatEvent(event("1", "user_message", 1, {
        text: "hidden",
        metadata: { ui: { visibility: "hidden" } },
      })),
    ).toBe(false);

    expect(
      isUiDisplayableChatEvent(event("2", "user_message", 2, {
        text: "workspace request",
        metadata: {
          trigger: { kind: "workspace_creation_request" },
        },
      })),
    ).toBe(false);
  });

  it("renders ordinary user and assistant messages", () => {
    expect(
      isUiDisplayableChatEvent(event("1", "user_message", 1, { text: "hi" })),
    ).toBe(true);
    expect(
      isUiDisplayableChatEvent(
        event("2", "assistant_message", 2, { text: "hello" }),
      ),
    ).toBe(true);
  });

  it("counts only visible chat messages", () => {
    const events = [
      event("1", "user_message", 1, { text: "hello" }),
      event("2", "assistant_message", 2, { text: "hi" }),
      event("3", "user_message", 3, {
        text: "hidden",
        metadata: { ui: { visibility: "hidden" } },
      }),
      event("4", "assistant_message", 4, { text: "another reply" }),
      event("5", "tool_result", 5, { toolName: "Read" }),
    ];

    expect(countVisibleChatMessageEvents(events)).toBe(3);
  });

  it("slices from the oldest visible message in the requested window", () => {
    const events = [
      event("1", "user_message", 1, { text: "older prompt" }),
      event("2", "assistant_message", 2, { text: "older reply" }),
      event("3", "user_message", 3, {
        text: "hidden follow-up",
        metadata: { ui: { visibility: "hidden" } },
      }),
      event("4", "assistant_message", 4, { text: "follow-up reply" }),
      event("5", "user_message", 5, { text: "latest prompt" }),
      event("6", "tool_request", 6, { toolName: "Read" }),
      event("7", "assistant_message", 7, { text: "latest reply" }),
      event("8", "agent-progress", 8, { agentId: "task-1", statusText: "Working" }),
    ];

    expect(
      sliceEventsByVisibleMessageWindow(events, 2).map((entry) => entry._id),
    ).toEqual(["5", "6", "7", "8"]);
  });
});
