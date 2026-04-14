import { describe, expect, it } from "vitest";
import { buildChatPromptMessages } from "../../../runtime/kernel/chat-prompt-context.js";

describe("buildChatPromptMessages", () => {
  it("marks hidden active-window context as an internal message", () => {
    const result = buildChatPromptMessages({
      userPrompt: "Help with this",
      chatContext: {
        window: {
          app: "Cursor",
          title: "stella/runtime",
        },
      } as never,
    });

    expect(result.visibleUserPrompt).toBe("Help with this");
    expect(result.promptMessages).toEqual([
      expect.objectContaining({
        uiVisibility: "hidden",
        messageType: "message",
      }),
    ]);
  });
});
