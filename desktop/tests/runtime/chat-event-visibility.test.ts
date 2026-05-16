import { describe, expect, it } from "vitest";
import { isUiDisplayableChatEvent } from "../../../runtime/chat-event-visibility";

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
});
