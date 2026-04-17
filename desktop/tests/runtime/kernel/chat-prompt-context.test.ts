import { describe, expect, it } from "vitest";
import { buildChatPromptMessages } from "../../../../runtime/kernel/chat-prompt-context.js";

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

  it("describes explicit images before the ambient window screenshot", () => {
    const result = buildChatPromptMessages({
      userPrompt: "What am I looking at?",
      explicitImageAttachmentCount: 2,
      chatContext: {
        window: {
          app: "Cursor",
          title: "stella/runtime",
        },
        windowScreenshot: {
          dataUrl: "data:image/png;base64,AAAA",
          width: 10,
          height: 10,
        },
      } as never,
    });

    expect(result.promptMessages?.[0]?.text).toContain(
      "first 2 images are user-provided",
    );
    expect(result.promptMessages?.[0]?.text).toContain(
      "final image is a screenshot",
    );
  });
});
