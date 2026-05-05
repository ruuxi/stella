import { describe, expect, it } from "vitest";
import { prepareStoredLocalChatPayload } from "../../../../../runtime/kernel/storage/local-chat-payload.js";

describe("prepareStoredLocalChatPayload", () => {
  it("normalizes Fireworks output_text wrappers before storing assistant messages", () => {
    const wrappedText = String.raw`[{'type': 'output_text', 'text': "done — it's called Identity and it's sitting in the sidebar now.\n\nhere's what it does:", 'annotations': []}]`;

    expect(
      prepareStoredLocalChatPayload({
        type: "assistant_message",
        payload: {
          text: wrappedText,
          userMessageId: "user-1",
        },
        timestamp: 1_000,
      }),
    ).toEqual({
      text: "done — it's called Identity and it's sitting in the sidebar now.\n\nhere's what it does:",
      userMessageId: "user-1",
    });
  });
});
