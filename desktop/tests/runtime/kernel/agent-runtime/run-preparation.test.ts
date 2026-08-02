import { describe, expect, it } from "vitest";
import {
  createRuntimePromptAgentMessage,
  createUserPromptMessage,
  prepareRuntimeAttachments,
} from "../../../../../runtime/kernel/agent-runtime/run-preparation.js";

describe("run preparation attachments", () => {
  const validPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  it("only converts image data URLs into image content blocks", () => {
    const message = createUserPromptMessage("Look at this", [
      {
        url: "data:image/PNG;base64,AAAA",
        mimeType: "image/PNG",
        sourcePath: "/tmp/source.png",
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
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
        sourcePath: "/tmp/source.png",
      },
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

  it("validates image bytes before native history ingestion", async () => {
    const prepared = await prepareRuntimeAttachments([
      {
        url: `data:image/png;base64,${validPng}`,
        mimeType: "image/png",
        sourcePath: "/tmp/retained.png",
      },
      {
        url: "data:image/png;base64,AAAA",
        mimeType: "image/png",
      },
    ]);

    expect(prepared).toHaveLength(1);
    expect(prepared?.[0]?.url).toMatch(/^data:image\/(?:png|jpeg);base64,/);
    expect(prepared?.[0]?.size).toBeGreaterThan(0);
    expect(prepared?.[0]?.sourcePath).toBe("/tmp/retained.png");
  });
});
