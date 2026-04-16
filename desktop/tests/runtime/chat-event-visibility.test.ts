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
  it("hides message events that should never render in the transcript", () => {
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

    expect(
      isUiDisplayableChatEvent(event("3", "assistant_message", 3, {
        text: "[TOOL CALL: Read]",
      })),
    ).toBe(false);
  });

  it("counts only visible chat messages", () => {
    const events = [
      event("1", "user_message", 1, { text: "hello" }),
      event("2", "assistant_message", 2, { text: "hi" }),
      event("3", "user_message", 3, {
        text: "hidden",
        metadata: { ui: { visibility: "hidden" } },
      }),
      event("4", "assistant_message", 4, { text: "[WEB SEARCH]" }),
      event("5", "tool_result", 5, { toolName: "Read" }),
    ];

    expect(countVisibleChatMessageEvents(events)).toBe(2);
  });

  it("slices from the oldest visible message in the requested window", () => {
    const events = [
      event("1", "user_message", 1, { text: "older prompt" }),
      event("2", "assistant_message", 2, { text: "older reply" }),
      event("3", "user_message", 3, {
        text: "hidden follow-up",
        metadata: { ui: { visibility: "hidden" } },
      }),
      event("4", "assistant_message", 4, { text: "[ORCHESTRATOR RESULT]" }),
      event("5", "user_message", 5, { text: "latest prompt" }),
      event("6", "tool_request", 6, { toolName: "Read" }),
      event("7", "assistant_message", 7, { text: "latest reply" }),
      event("8", "task_progress", 8, { taskId: "task-1", statusText: "Working" }),
    ];

    expect(
      sliceEventsByVisibleMessageWindow(events, 2).map((entry) => entry._id),
    ).toEqual(["5", "6", "7", "8"]);
  });
});
