import { describe, expect, it } from "vitest";
import {
  createRuntimePromptAgentMessage,
  createUserPromptMessage,
} from "../../../../../runtime/kernel/agent-runtime/run-preparation.js";

describe("run preparation attachments", () => {
  it("only converts image data URLs into image content blocks", () => {
    const message = createUserPromptMessage("Look at this", [
      {
        url: "data:image/PNG;base64,AAAA",
        mimeType: "image/PNG",
      },
      {
        url: "data:text/plain;base64,SGVsbG8=",
        mimeType: "text/plain",
      },
      {
        url: "https://example.com/cat.png",
        mimeType: "image/png",
      },
    ]);

    expect(message.content).toEqual([
      { type: "text", text: "Look at this" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ]);
  });

  it("applies the same image filtering to runtime prompt messages", () => {
    const message = createRuntimePromptAgentMessage(
      {
        text: "Context",
        messageType: "message",
        attachments: [
          {
            url: "data:image/jpeg;base64,BBBB",
          },
          {
            url: "data:application/pdf;base64,CCCC",
            mimeType: "application/pdf",
          },
        ],
      },
      123,
    );

    expect(message).toEqual({
      role: "runtimeInternal",
      content: [
        { type: "text", text: "Context" },
        { type: "image", mimeType: "image/jpeg", data: "BBBB" },
      ],
      timestamp: 123,
    });
  });
});
